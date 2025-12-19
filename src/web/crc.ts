import type { Bytes } from './bytes.js';

function crc8Dji(data: Bytes): number {
  // CRC-8 parameters used by this protocol (from existing Node code):
  // poly=0x31, init=0xee, refin=true, refout=true, xorout=0x00
  // For a reflected implementation, the polynomial is bit-reversed: 0x31 -> 0x8c.
  let crc = 0xee;
  const poly = 0x8c;
  for (let i = 0; i < data.byteLength; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x01) !== 0 ? (crc >>> 1) ^ poly : crc >>> 1;
    }
    crc &= 0xff;
  }
  return crc & 0xff;
}

function crc16Dji(data: Bytes): number {
  // CRC-16 parameters used by this protocol (from existing Node code):
  // poly=0x1021, init=0x496c, refin=true, refout=true, xorout=0x0000
  // Reflected polynomial: 0x1021 -> 0x8408.
  let crc = 0x496c;
  const poly = 0x8408;
  for (let i = 0; i < data.byteLength; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x0001) !== 0 ? (crc >>> 1) ^ poly : crc >>> 1;
    }
    crc &= 0xffff;
  }
  return crc & 0xffff;
}

export const djiCrc8 = crc8Dji;
export const djiCrc16 = crc16Dji;
