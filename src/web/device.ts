import { DjiDeviceModel } from './deviceTypes.js';
import { createDjiDeviceStore, type DjiDeviceState, type DjiDeviceStore } from './deviceStore.js';
import type { DjiDeviceImageStabilization, DjiDeviceResolution } from './message.js';
import { startWebDjiDeviceRunner, type WebDjiDeviceRunner, type WebDjiDeviceRunnerOptions } from './deviceRunner.js';
import { WebBluetoothTransport } from './transport.js';
import type { WriteProfile } from './writeStrategy.js';
import { writeProfiles } from './writeStrategy.js';

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
  private readonly store: DjiDeviceStore;
  private readonly runner: WebDjiDeviceRunner;
  private readonly transport: WebBluetoothTransport;

  /**
   * Optional state-change callback, for consumers who prefer the old "onStateChange" hook.
   * In the store-driven architecture, this is wired from store subscription.
   */
  onStateChange?: (device: WebDjiDevice, state: DjiDeviceState) => void;

  constructor(options: {
    model: DjiDeviceModel;
    runner?: WebDjiDeviceRunnerOptions;
    transport?: WebBluetoothTransport;
    writeProfile?: WriteProfile;
  }) {
    this.store = createDjiDeviceStore({ model: options.model });
    this.transport = options.transport ?? new WebBluetoothTransport();
    this.runner = startWebDjiDeviceRunner(this.store, {
      ...options.runner,
      transport: this.transport,
      writeProfile: options.writeProfile ?? writeProfiles.conservative,
    });

    this.store.subscribe((snapshot) => {
      this.onStateChange?.(this, snapshot.context.state);
    });
  }

  getState(): DjiDeviceState {
    return this.store.getSnapshot().context.state;
  }

  getBatteryPercentage(): number | undefined {
    return this.store.getSnapshot().context.batteryPercentage;
  }

  setPairPinCode(pinCode: string): void {
    this.store.send({ type: 'set_pair_pin_code', pinCode } as unknown as { type: string });
  }

  async requestDevice(): Promise<BluetoothDevice> {
    return this.transport.requestDevice();
  }

  async startLiveStream(options: StartLiveStreamOptions): Promise<void> {
    const startTimeoutMs = options.startTimeoutMs ?? 60_000;

    this.store.send({
      type: 'start_requested',
      wifiSsid: options.wifiSsid,
      wifiPassword: options.wifiPassword,
      rtmpUrl: options.rtmpUrl,
      resolution: options.resolution,
      fps: options.fps,
      bitrate: options.bitrate,
      imageStabilization: options.imageStabilization,
      device: options.device,
    } as unknown as { type: string });

    await waitForStreamingOrError(this.store, startTimeoutMs + 500);
  }

  stopLiveStream(): void {
    this.store.send({ type: 'stop_requested' } as unknown as { type: string });
  }

  dispose(): void {
    this.runner.stop();
  }
}

function waitForStreamingOrError(
  store: DjiDeviceStore,
  timeoutMs: number,
): Promise<void> {
  const snap = store.getSnapshot().context;
  if (snap.state === 'streaming') return Promise.resolve();
  if (snap.state === 'idle' && snap.error) return Promise.reject(new Error(snap.error.message));

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      sub.unsubscribe();
      reject(new Error('Start timeout'));
    }, timeoutMs);

    const sub = store.subscribe((snapshot) => {
      const ctx = snapshot.context;
      if (ctx.state === 'streaming') {
        window.clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      } else if (ctx.state === 'idle' && ctx.error) {
        window.clearTimeout(timer);
        sub.unsubscribe();
        reject(new Error(ctx.error.message));
      }
    });
  });
}

