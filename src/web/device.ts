import { bytesEqual } from './bytes.js';
import { DjiFramer } from './framer.js';
import {
  DjiConfigureMessagePayload,
  DjiConfirmStartStreamingMessagePayload,
  DjiDeviceImageStabilization,
  DjiDeviceResolution,
  DjiMessage,
  DjiPairMessagePayload,
  DjiPreparingToLivestreamMessagePayload,
  DjiSetupWifiMessagePayload,
  DjiStartStreamingMessagePayload,
  DjiStopStreamingMessagePayload,
} from './message.js';
import { type ConnectedTransport, WebBluetoothTransport } from './transport.js';
import { MessageWriter, type WriteProfile, writeProfiles } from './writeStrategy.js';

export enum DjiDeviceModel {
  osmoAction3,
  osmoAction4,
  osmoAction5Pro,
  osmoPocket3,
  unknown,
}

export enum DjiDeviceState {
  idle,
  connecting,
  checkingIfPaired,
  cleaningUp,
  preparingStream,
  settingUpWifi,
  configuring,
  startingStream,
  streaming,
  stoppingStream,
}

const pairTransactionId = 0x8092;
const stopStreamingTransactionId = 0xeac8;
const preparingToLivestreamTransactionId = 0x8c12;
const setupWifiTransactionId = 0x8c19;
const startStreamingTransactionId = 0x8c2c;
const configureTransactionId = 0x8c2d;

const pairTarget = 0x0702;
const stopStreamingTarget = 0x0802;
const preparingToLivestreamTarget = 0x0802;
const setupWifiTarget = 0x0702;
const configureTarget = 0x0102;
const startStreamingTarget = 0x0802;

const pairType = 0x450740;
const stopStreamingType = 0x8e0240;
const preparingToLivestreamType = 0xe10240;
const setupWifiType = 0x470740;
const configureType = 0x8e0240;
const startStreamingType = 0x780840;

export interface StartLiveStreamOptions {
  wifiSsid: string;
  wifiPassword: string;
  rtmpUrl: string;
  resolution: DjiDeviceResolution;
  fps: number;
  bitrate: number;
  imageStabilization: DjiDeviceImageStabilization;
  /**
   * If provided, we skip `navigator.bluetooth.requestDevice()` and connect directly.
   * This is useful for testing and for “reconnect to remembered device” UX.
   */
  device?: BluetoothDevice;
  /**
   * Timeout until we reach streaming state.
   */
  startTimeoutMs?: number;
}

export class WebDjiDevice {
  private readonly model: DjiDeviceModel;
  private readonly transport: WebBluetoothTransport;
  private readonly framer = new DjiFramer();
  private readonly writeProfile: WriteProfile;

  private connected?: ConnectedTransport;
  private writer?: MessageWriter;
  private unsubBytes?: () => void;

  private pairPinCode: string = 'love';
  private state: DjiDeviceState = DjiDeviceState.idle;
  private batteryPercentage?: number;

  private wifiSsid?: string;
  private wifiPassword?: string;
  private rtmpUrl?: string;
  private resolution?: DjiDeviceResolution;
  private fps: number = 30;
  private bitrate: number = 6_000_000;
  private imageStabilization?: DjiDeviceImageStabilization;

  private startTimer?: number;
  private pendingStart?: { resolve: () => void; reject: (err: unknown) => void };

  onStateChange?: (device: WebDjiDevice, state: DjiDeviceState) => void;

  constructor(options: {
    model: DjiDeviceModel;
    transport?: WebBluetoothTransport;
    writeProfile?: WriteProfile;
  }) {
    this.model = options.model;
    this.transport = options.transport ?? new WebBluetoothTransport();
    this.writeProfile = options.writeProfile ?? writeProfiles.conservative;
  }

  getState(): DjiDeviceState {
    return this.state;
  }

  getBatteryPercentage(): number | undefined {
    return this.batteryPercentage;
  }

  setPairPinCode(pinCode: string): void {
    this.pairPinCode = pinCode;
  }

  async requestDevice(): Promise<BluetoothDevice> {
    return this.transport.requestDevice();
  }

  async startLiveStream(options: StartLiveStreamOptions): Promise<void> {
    if (this.state !== DjiDeviceState.idle) {
      throw new Error('Device is not idle');
    }

    this.wifiSsid = options.wifiSsid;
    this.wifiPassword = options.wifiPassword;
    this.rtmpUrl = options.rtmpUrl;
    this.resolution = options.resolution;
    this.fps = options.fps;
    this.bitrate = options.bitrate;
    this.imageStabilization = options.imageStabilization;

    const startTimeoutMs = options.startTimeoutMs ?? 60_000;
    await this.connectAndRun(startTimeoutMs, options.device);
  }

  stopLiveStream(): void {
    if (!this.connected) return;
    if (this.state === DjiDeviceState.idle) return;
    this.sendStopStream();
    this.setState(DjiDeviceState.stoppingStream);
    this.cleanup();
  }

  private async connectAndRun(startTimeoutMs: number, device?: BluetoothDevice): Promise<void> {
    const chosen = device ?? (await this.transport.requestDevice());

    this.setState(DjiDeviceState.connecting);
    this.connected = await this.transport.connect(chosen);
    this.writer = new MessageWriter(this.connected, this.writeProfile);

    this.unsubBytes = this.connected.onBytes((source, bytes) => {
      // Mirror Node behavior: first time we see bytes on fff4 while connecting, attempt pairing.
      if (this.state === DjiDeviceState.connecting && source === 'fff4') {
        this.attemptPair();
        // Continue; framing layer will also see the bytes (noise-tolerant).
      }

      const messages = this.framer.push(bytes);
      for (const msg of messages) {
        this.onMessage(msg);
      }
    });

    // Setup timeout + await streaming.
    await new Promise<void>((resolve, reject) => {
      this.pendingStart = { resolve, reject };
      this.startTimer = window.setTimeout(() => {
        this.pendingStart = undefined;
        this.cleanup();
        reject(new Error('Start timeout'));
      }, startTimeoutMs);
    });
  }

  private setState(next: DjiDeviceState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(this, next);
  }

  private cleanup(): void {
    if (this.startTimer) {
      window.clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    this.pendingStart = undefined;
    this.unsubBytes?.();
    this.unsubBytes = undefined;
    this.connected?.disconnect();
    this.connected = undefined;
    this.writer = undefined;
    this.framer.reset();
    this.batteryPercentage = undefined;
    this.setState(DjiDeviceState.idle);
  }

  private async writeMessage(message: DjiMessage): Promise<void> {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(message.encode());
  }

  private attemptPair(): void {
    const payload = new DjiPairMessagePayload(this.pairPinCode);
    const request = new DjiMessage(pairTarget, pairTransactionId, pairType, payload.encode());
    void this.writeMessage(request);
    this.setState(DjiDeviceState.checkingIfPaired);
  }

  private sendStopStream(): void {
    const payload = new DjiStopStreamingMessagePayload();
    void this.writeMessage(
      new DjiMessage(
        stopStreamingTarget,
        stopStreamingTransactionId,
        stopStreamingType,
        payload.encode(),
      ),
    );
  }

  private sendPreparingToLivestream(): void {
    const payload = new DjiPreparingToLivestreamMessagePayload();
    void this.writeMessage(
      new DjiMessage(
        preparingToLivestreamTarget,
        preparingToLivestreamTransactionId,
        preparingToLivestreamType,
        payload.encode(),
      ),
    );
    this.setState(DjiDeviceState.preparingStream);
  }

  private sendSetupWifi(): void {
    if (!this.wifiSsid || !this.wifiPassword) return;
    const payload = new DjiSetupWifiMessagePayload(this.wifiSsid, this.wifiPassword);
    void this.writeMessage(
      new DjiMessage(setupWifiTarget, setupWifiTransactionId, setupWifiType, payload.encode()),
    );
    this.setState(DjiDeviceState.settingUpWifi);
  }

  private sendConfigure(oa5: boolean): void {
    if (!this.imageStabilization) return;
    const payload = new DjiConfigureMessagePayload(this.imageStabilization, oa5);
    void this.writeMessage(
      new DjiMessage(configureTarget, configureTransactionId, configureType, payload.encode()),
    );
    this.setState(DjiDeviceState.configuring);
  }

  private sendStartStreaming(): void {
    if (!this.rtmpUrl || !this.resolution) return;
    const payload = new DjiStartStreamingMessagePayload(
      this.rtmpUrl,
      this.resolution,
      this.fps,
      this.bitrate / 1000,
      this.model === DjiDeviceModel.osmoAction5Pro,
    );
    void this.writeMessage(
      new DjiMessage(
        startStreamingTarget,
        startStreamingTransactionId,
        startStreamingType,
        payload.encode(),
      ),
    );

    if (this.model === DjiDeviceModel.osmoAction5Pro) {
      const confirm = new DjiConfirmStartStreamingMessagePayload();
      void this.writeMessage(
        new DjiMessage(
          stopStreamingTarget,
          stopStreamingTransactionId,
          stopStreamingType,
          confirm.encode(),
        ),
      );
    }

    this.setState(DjiDeviceState.startingStream);
  }

  private onMessage(message: DjiMessage): void {
    switch (this.state) {
      case DjiDeviceState.checkingIfPaired: {
        if (message.id !== pairTransactionId) return;
        if (bytesEqual(message.payload, Uint8Array.of(0, 1))) {
          // In Node implementation, "already paired" proceeds to cleanup.
          this.sendStopStream();
          this.setState(DjiDeviceState.cleaningUp);
        } else {
          // If not paired, we still follow stop-stream then proceed.
          this.sendStopStream();
          this.setState(DjiDeviceState.cleaningUp);
        }
        return;
      }

      case DjiDeviceState.cleaningUp:
        if (message.id !== stopStreamingTransactionId) return;
        this.sendPreparingToLivestream();
        return;

      case DjiDeviceState.preparingStream:
        if (message.id !== preparingToLivestreamTransactionId) return;
        this.sendSetupWifi();
        return;

      case DjiDeviceState.settingUpWifi:
        if (message.id !== setupWifiTransactionId) return;
        switch (this.model) {
          case DjiDeviceModel.osmoAction4:
            this.sendConfigure(false);
            return;
          case DjiDeviceModel.osmoAction5Pro:
            this.sendConfigure(true);
            return;
          default:
            this.sendStartStreaming();
            return;
        }

      case DjiDeviceState.configuring:
        if (message.id !== configureTransactionId) return;
        this.sendStartStreaming();
        return;

      case DjiDeviceState.startingStream:
        if (message.id !== startStreamingTransactionId) return;
        this.setState(DjiDeviceState.streaming);
        if (this.startTimer) {
          window.clearTimeout(this.startTimer);
          this.startTimer = undefined;
        }
        this.pendingStart?.resolve();
        this.pendingStart = undefined;
        return;

      case DjiDeviceState.streaming:
        // Battery message
        if (message.type === 0x020d00 && message.payload.byteLength >= 21) {
          this.batteryPercentage = message.payload[20];
        }
        return;

      default:
        return;
    }
  }
}

