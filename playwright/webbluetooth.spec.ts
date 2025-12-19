import { test, expect } from '@playwright/test';

test('WebDjiDevice runs the start-stream sequence over mocked WebBluetooth', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // A minimal mock of the Web Bluetooth API surface that our transport uses.
    class FakeCharacteristic extends EventTarget {
      uuid: string;
      value?: DataView;
      private onWrite?: (bytes: Uint8Array) => void;
      private notificationsStarted = false;

      constructor(uuid: string) {
        super();
        this.uuid = uuid;
      }

      setWriteHandler(handler: (bytes: Uint8Array) => void): void {
        this.onWrite = handler;
      }

      async startNotifications(): Promise<this> {
        this.notificationsStarted = true;
        return this;
      }

      async writeValueWithResponse(data: BufferSource): Promise<void> {
        this.onWrite?.(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
      }

      async writeValueWithoutResponse(data: BufferSource): Promise<void> {
        this.onWrite?.(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
      }

      emit(bytes: Uint8Array): void {
        if (!this.notificationsStarted) return;
        this.value = new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }

    class FakeService {
      private characteristics: Map<string, FakeCharacteristic>;
      constructor(characteristics: Map<string, FakeCharacteristic>) {
        this.characteristics = characteristics;
      }
      async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
        const c = this.characteristics.get(uuid);
        if (!c) throw new Error(`Missing characteristic ${uuid}`);
        return c;
      }
    }

    class FakeGattServer {
      connected = true;
      private service: FakeService;
      constructor(service: FakeService) {
        this.service = service;
      }
      async getPrimaryService(_uuid: string): Promise<FakeService> {
        void _uuid;
        return this.service;
      }
      disconnect(): void {
        this.connected = false;
      }
    }

    class FakeDevice {
      id = 'fake-device-id';
      name = 'DJI Fake';
      gatt: FakeGattServer;
      constructor(gatt: FakeGattServer) {
        this.gatt = gatt;
      }
    }

    // Install on navigator.bluetooth
    const bluetooth = {
      async requestDevice(_options: unknown): Promise<unknown> {
        void _options;
        // This will be replaced in-page once the module is loaded (so we can decode/encode frames).
        // For now, return the device stored on window.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).__FAKE_DEVICE__;
      },
      async getDevices(): Promise<unknown[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return [(window as any).__FAKE_DEVICE__];
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).bluetooth = bluetooth;

    // Expose constructors for later wiring.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__WB_MOCK__ = {
      FakeCharacteristic,
      FakeService,
      FakeGattServer,
      FakeDevice,
    };
  });

  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = '/playwright/static/harness.mjs';
      s.onload = (): void => resolve();
      s.onerror = (): void => reject(new Error('Failed to load harness module'));
      document.head.appendChild(s);
    });
  });
  await page.waitForFunction(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).__WEB__ !== undefined;
  });

  const result = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const web = (globalThis as any).__WEB__;

    const {
      DJI_CHAR_FFF3,
      DJI_CHAR_FFF4,
      DJI_CHAR_FFF5,
      DjiMessage,
      DjiFramer,
      WebDjiDevice,
      DjiDeviceModel,
      DjiDeviceResolution,
      DjiDeviceImageStabilization,
    } = web;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { FakeCharacteristic, FakeService, FakeGattServer, FakeDevice } = (window as any).__WB_MOCK__;

    const fff3 = new FakeCharacteristic(DJI_CHAR_FFF3);
    const fff4 = new FakeCharacteristic(DJI_CHAR_FFF4);
    const fff5 = new FakeCharacteristic(DJI_CHAR_FFF5);

    // Create a fake GATT hierarchy.
    const service = new FakeService(
      new Map([
        [DJI_CHAR_FFF3, fff3],
        [DJI_CHAR_FFF4, fff4],
        [DJI_CHAR_FFF5, fff5],
      ]),
    );
    const gatt = new FakeGattServer(service);
    // FakeDevice needs a gatt.connect() method in real WebBluetooth.
    // We emulate it by patching connect() onto gatt.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gatt as any).connect = async (): Promise<unknown> => gatt;
    const device = new FakeDevice(gatt);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__FAKE_DEVICE__ = device;

    // Helper: emit a response frame (as if from camera).
    const emitFrame = (
      characteristic: InstanceType<typeof FakeCharacteristic>,
      msg: InstanceType<typeof DjiMessage>,
    ): void => {
      characteristic.emit(msg.encode());
    };

    // Wire “camera” behavior: respond to writes by parsing chunked frames and emitting expected acks.
    const writeFramer = new DjiFramer();
    fff3.setWriteHandler((bytes: Uint8Array) => {
      for (const request of writeFramer.push(bytes)) {
        // Echo-ack the command by transaction id; payloads can be minimal for this flow.
        switch (request.id) {
          case 0x8092: // pair
            emitFrame(
              fff4,
              new DjiMessage(request.target, request.id, request.type, Uint8Array.of(0, 1)),
            );
            break;
          case 0xeac8: // stop streaming
            emitFrame(fff4, new DjiMessage(request.target, request.id, request.type, new Uint8Array()));
            break;
          case 0x8c12: // preparing
            emitFrame(fff4, new DjiMessage(request.target, request.id, request.type, new Uint8Array()));
            break;
          case 0x8c19: // setup wifi
            emitFrame(fff4, new DjiMessage(request.target, request.id, request.type, new Uint8Array()));
            break;
          case 0x8c2d: // configure
            emitFrame(fff4, new DjiMessage(request.target, request.id, request.type, new Uint8Array()));
            break;
          case 0x8c2c: { // start streaming
            emitFrame(fff4, new DjiMessage(request.target, request.id, request.type, new Uint8Array()));

            // After we’re “streaming”, send a battery update message.
            // type=0x020d00, battery at payload[20]
            const payload = new Uint8Array(21).fill(0);
            payload[20] = 77;
            emitFrame(fff5, new DjiMessage(0x0000, 0x0000, 0x020d00, payload));
            break;
          }
          default:
            // ignore
            break;
        }
      }
    });

    // Kick off: when notifications start, the camera typically sends something on fff4.
    // Emit noise *after* startNotifications is called so the controller sees it.
    const originalStartNotifications = fff4.startNotifications.bind(fff4);
    fff4.startNotifications = async (): Promise<unknown> => {
      const out = await originalStartNotifications();
      setTimeout((): void => fff4.emit(Uint8Array.of(0x01)), 0);
      return out;
    };

    const cam = new WebDjiDevice({ model: DjiDeviceModel.osmoAction4 });
    await cam.startLiveStream({
      wifiSsid: 'ssid',
      wifiPassword: 'password',
      rtmpUrl: 'rtmp://example.com/live/streamKey',
      resolution: DjiDeviceResolution.r1080p,
      fps: 30,
      bitrate: 6_000_000,
      imageStabilization: DjiDeviceImageStabilization.RockSteadyPlus,
      device,
      startTimeoutMs: 5000,
    });

    // Give battery message a beat to process
    await new Promise((r) => setTimeout(r, 10));

    return {
      state: cam.getState(),
      battery: cam.getBatteryPercentage(),
    };
  });

  expect(result.state).toBe(8); // DjiDeviceState.streaming
  expect(result.battery).toBe(77);
});

