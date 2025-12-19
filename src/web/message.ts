import type { Bytes } from './bytes.js';
import { concatBytes, toHex, u16le, u24le, u8 } from './bytes.js';
import { ByteBuf } from './bytebuf.js';
import { djiCrc16, djiCrc8 } from './crc.js';

export interface DjiMessageLike {
  target: number;
  id: number;
  type: number;
  payload: Bytes;
}

export class DjiMessage implements DjiMessageLike {
  target: number;
  id: number;
  type: number;
  payload: Bytes;

  constructor(target: number, id: number, type: number, payload: Bytes) {
    this.target = target;
    this.id = id;
    this.type = type;
    this.payload = payload;
  }

  encode(): Bytes {
    const length = 13 + this.payload.byteLength;
    if (length > 0xff) {
      throw new Error(`Frame too large (${length} bytes); length must fit uint8`);
    }

    const header = Uint8Array.of(0x55, length & 0xff, 0x04);
    const headerCrc = djiCrc8(header);
    const headerWithCrc = concatBytes(header, u8(headerCrc));

    const body = concatBytes(
      headerWithCrc,
      u16le(this.target),
      u16le(this.id),
      u24le(this.type),
      this.payload,
    );
    const crc = djiCrc16(body);
    return concatBytes(body, u16le(crc));
  }

  format(): string {
    return `DjiMessage(target=${this.target}, id=${this.id}, type=${this.type}, payload=${toHex(this.payload)})`;
  }

  static decodeFrame(frame: Bytes): DjiMessage {
    const reader = ByteBuf.from(frame);
    if (reader.readUint8() !== 0x55) {
      throw new Error('Bad first byte');
    }

    const length = reader.readUint8();
    if (frame.byteLength !== length) {
      throw new Error('Bad length');
    }

    const version = reader.readUint8();
    if (version !== 0x04) {
      throw new Error('Bad version');
    }

    const headerCrc = reader.readUint8();
    const calculatedHeaderCrc = djiCrc8(frame.subarray(0, 3));
    if (headerCrc !== calculatedHeaderCrc) {
      throw new Error(
        `Calculated header CRC ${calculatedHeaderCrc} does not match received CRC ${headerCrc}`,
      );
    }

    const target = reader.readUint16le();
    const id = reader.readUint16le();
    const type = reader.readUint24le();
    const payload = reader.readBytes(reader.bytesRemaining - 2);
    const crc = reader.readUint16le();
    const calculatedCrc = djiCrc16(frame.subarray(0, frame.byteLength - 2));
    if (crc !== calculatedCrc) {
      throw new Error(
        `Calculated CRC ${calculatedCrc} does not match received CRC ${crc}`,
      );
    }

    return new DjiMessage(target, id, type, payload);
  }
}

function packUtf8String(value: string): Bytes {
  return new TextEncoder().encode(value);
}

function djiPackString(value: string): Bytes {
  const data = packUtf8String(value);
  if (data.byteLength > 0xff) {
    throw new Error(`String too long for DJI packString: ${data.byteLength}`);
  }
  return concatBytes(u8(data.byteLength), data);
}

function djiPackUrl(url: string): Bytes {
  const data = packUtf8String(url);
  if (data.byteLength > 0xff) {
    throw new Error(`URL too long for DJI packUrl: ${data.byteLength}`);
  }
  // Node implementation prefixes [len, 0] before the bytes.
  return concatBytes(Uint8Array.of(data.byteLength, 0x00), data);
}

export class DjiPairMessagePayload {
  // Copied from existing Node payload.
  static payload = Uint8Array.from([
    0x20, 0x32, 0x38, 0x34, 0x61, 0x65, 0x35, 0x62, 0x38, 0x64, 0x37,
    0x36, 0x62, 0x33, 0x33, 0x37, 0x35, 0x61, 0x30, 0x34, 0x61, 0x36,
    0x34, 0x31, 0x37, 0x61, 0x64, 0x37, 0x31, 0x62, 0x65, 0x61, 0x33,
  ]);

  pairPinCode: string;
  constructor(pairPinCode: string) {
    this.pairPinCode = pairPinCode;
  }

  encode(): Bytes {
    return concatBytes(DjiPairMessagePayload.payload, djiPackString(this.pairPinCode));
  }
}

export class DjiPreparingToLivestreamMessagePayload {
  static payload = Uint8Array.of(0x1a);
  encode(): Bytes {
    return DjiPreparingToLivestreamMessagePayload.payload;
  }
}

export class DjiSetupWifiMessagePayload {
  wifiSsid: string;
  wifiPassword: string;

  constructor(wifiSsid: string, wifiPassword: string) {
    this.wifiSsid = wifiSsid;
    this.wifiPassword = wifiPassword;
  }

  encode(): Bytes {
    return concatBytes(djiPackString(this.wifiSsid), djiPackString(this.wifiPassword));
  }
}

export enum DjiDeviceResolution {
  r480p = '480p',
  r720p = '720p',
  r1080p = '1080p',
}

export enum DjiDeviceImageStabilization {
  Off = 'Off',
  RockSteady = 'RockSteady',
  RockSteadyPlus = 'RockSteady+',
  HorizonBalancing = 'HorizonBalancing',
  HorizonSteady = 'HorizonSteady',
}

export class DjiStartStreamingMessagePayload {
  static payload1 = Uint8Array.of(0x00);
  static payload2 = Uint8Array.of(0x00);
  static payload3 = Uint8Array.of(0x02, 0x00);
  static payload4 = Uint8Array.of(0x00, 0x00, 0x00);

  rtmpUrl: string;
  resolution: DjiDeviceResolution;
  fps: number;
  bitrateKbps: number;
  oa5: boolean;

  constructor(
    rtmpUrl: string,
    resolution: DjiDeviceResolution,
    fps: number,
    bitrateKbps: number,
    oa5: boolean,
  ) {
    this.rtmpUrl = rtmpUrl;
    this.resolution = resolution;
    this.fps = fps;
    this.bitrateKbps = bitrateKbps;
    this.oa5 = oa5;
  }

  encode(): Bytes {
    let resolutionByte: number;
    switch (this.resolution) {
      case DjiDeviceResolution.r480p:
        resolutionByte = 0x47;
        break;
      case DjiDeviceResolution.r720p:
        resolutionByte = 0x04;
        break;
      case DjiDeviceResolution.r1080p:
        resolutionByte = 0x0a;
        break;
      default:
        throw new Error('Unknown resolution');
    }

    const bitrate = Uint8Array.of(
      this.bitrateKbps & 0xff,
      (this.bitrateKbps >> 8) & 0xff,
    );

    let fpsByte: number;
    switch (this.fps) {
      case 25:
        fpsByte = 2;
        break;
      case 30:
        fpsByte = 3;
        break;
      default:
        fpsByte = 0;
    }

    const byte1 = this.oa5 ? 0x2a : 0x2e;
    const url = djiPackUrl(this.rtmpUrl);

    return concatBytes(
      DjiStartStreamingMessagePayload.payload1,
      u8(byte1),
      DjiStartStreamingMessagePayload.payload2,
      u8(resolutionByte),
      bitrate,
      DjiStartStreamingMessagePayload.payload3,
      u8(fpsByte),
      DjiStartStreamingMessagePayload.payload4,
      url,
    );
  }
}

export class DjiConfirmStartStreamingMessagePayload {
  static payload = Uint8Array.from([0x01, 0x01, 0x1a, 0x00, 0x01, 0x01]);
  encode(): Bytes {
    return DjiConfirmStartStreamingMessagePayload.payload;
  }
}

export class DjiStopStreamingMessagePayload {
  static payload = Uint8Array.from([0x01, 0x01, 0x1a, 0x00, 0x01, 0x02]);
  encode(): Bytes {
    return DjiStopStreamingMessagePayload.payload;
  }
}

export class DjiConfigureMessagePayload {
  static payload1 = Uint8Array.from([0x01, 0x01]);
  static payload2 = Uint8Array.from([0x00, 0x01]);

  imageStabilization: DjiDeviceImageStabilization;
  oa5: boolean;

  constructor(imageStabilization: DjiDeviceImageStabilization, oa5: boolean) {
    this.imageStabilization = imageStabilization;
    this.oa5 = oa5;
  }

  encode(): Bytes {
    let imageStabilizationByte: number;
    switch (this.imageStabilization) {
      case DjiDeviceImageStabilization.Off:
        imageStabilizationByte = 0;
        break;
      case DjiDeviceImageStabilization.RockSteady:
        imageStabilizationByte = 1;
        break;
      case DjiDeviceImageStabilization.RockSteadyPlus:
        imageStabilizationByte = 3;
        break;
      case DjiDeviceImageStabilization.HorizonBalancing:
        imageStabilizationByte = 4;
        break;
      case DjiDeviceImageStabilization.HorizonSteady:
        imageStabilizationByte = 2;
        break;
      default:
        throw new Error('Unknown image stabilization');
    }

    const byte1 = this.oa5 ? 0x1a : 0x08;
    return concatBytes(
      DjiConfigureMessagePayload.payload1,
      u8(byte1),
      DjiConfigureMessagePayload.payload2,
      u8(imageStabilizationByte),
    );
  }
}
