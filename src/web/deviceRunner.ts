import { DjiDeviceModel } from './deviceTypes.js';
import type { DjiDeviceState, DjiDeviceStore } from './deviceStore.js';
import type { DjiDeviceContext } from './deviceStore.js';
import { DjiFramer } from './framer.js';
import {
  DjiConfigureMessagePayload,
  DjiConfirmStartStreamingMessagePayload,
  DjiMessage,
  DjiPairMessagePayload,
  DjiPreparingToLivestreamMessagePayload,
  DjiSetupWifiMessagePayload,
  DjiStartStreamingMessagePayload,
  DjiStopStreamingMessagePayload,
} from './message.js';
import type { ConnectedTransport } from './transport.js';
import { WebBluetoothTransport } from './transport.js';
import { MessageWriter, type WriteProfile, writeProfiles } from './writeStrategy.js';

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

export interface WebDjiDeviceRunnerOptions {
  transport?: WebBluetoothTransport;
  writeProfile?: WriteProfile;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface WebDjiDeviceRunner {
  stop(): void;
}

export function startWebDjiDeviceRunner(
  store: DjiDeviceStore,
  options: WebDjiDeviceRunnerOptions = {},
): WebDjiDeviceRunner {
  const transport = options.transport ?? new WebBluetoothTransport();
  const writeProfile = options.writeProfile ?? writeProfiles.conservative;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;

  const framer = new DjiFramer();

  let lastState: DjiDeviceState | undefined;
  let connected: ConnectedTransport | undefined;
  let writer: MessageWriter | undefined;
  let unsubBytes: (() => void) | undefined;

  let startTimer: number | undefined;
  let stopTimer: number | undefined;

  // Internal flags (kept out of store to keep context serializable).
  let stopStreamSent = false;

  const clearTimers = (): void => {
    if (startTimer) {
      window.clearTimeout(startTimer);
      startTimer = undefined;
    }
    if (stopTimer) {
      window.clearTimeout(stopTimer);
      stopTimer = undefined;
    }
  };

  const cleanup = (): void => {
    clearTimers();
    stopStreamSent = false;
    unsubBytes?.();
    unsubBytes = undefined;
    connected?.disconnect();
    connected = undefined;
    writer = undefined;
    framer.reset();
  };

  const write = async (message: DjiMessage): Promise<void> => {
    if (!writer) throw new Error('Not connected');
    await writer.write(message.encode());
  };

  const sendStopStream = async (): Promise<void> => {
    const payload = new DjiStopStreamingMessagePayload();
    await write(new DjiMessage(stopStreamingTarget, stopStreamingTransactionId, stopStreamingType, payload.encode()));
    stopStreamSent = true;
  };

  const ensureConnected = async (ctx: DjiDeviceContext): Promise<void> => {
    if (connected) return;
    if (!ctx.device) throw new Error('No device selected');
    connected = await transport.connect(ctx.device);
    writer = new MessageWriter(connected, writeProfile);
    unsubBytes = connected.onBytes((from, bytes) => {
      store.send({ type: 'bytes_received', from, bytes } as unknown as { type: string });
      for (const msg of framer.push(bytes)) {
        store.send({ type: 'message_received', message: msg } as unknown as { type: string });
      }
    });
    store.send({ type: 'connected' } as unknown as { type: string });
  };

  const handleStateEntry = async (ctx: DjiDeviceContext, state: DjiDeviceState): Promise<void> => {
    switch (state) {
      case 'discovering': {
        stopStreamSent = false;
        framer.reset();
        if (!startTimer) {
          startTimer = window.setTimeout(
            () => store.send({ type: 'start_timeout_expired' } as unknown as { type: string }),
            startTimeoutMs,
          );
        }

        if (ctx.device) {
          store.send({ type: 'device_chosen', device: ctx.device } as unknown as { type: string });
          return;
        }

        // Must be user-gesture driven in real apps; here runner calls it so consumers can wire it
        // behind a button.
        const device = await transport.requestDevice();
        store.send({ type: 'device_chosen', device } as unknown as { type: string });
        return;
      }

      case 'connecting': {
        await ensureConnected(ctx);
        return;
      }

      case 'checking_if_paired': {
        await ensureConnected(ctx);
        const payload = new DjiPairMessagePayload(ctx.pairPinCode);
        await write(new DjiMessage(pairTarget, pairTransactionId, pairType, payload.encode()));
        return;
      }

      case 'pairing': {
        await ensureConnected(ctx);
        // Per docs: entering pairing sends stop-stream then transitions to cleaning_up.
        await sendStopStream();
        store.send({ type: 'pairing_initiated' } as unknown as { type: string });
        return;
      }

      case 'cleaning_up': {
        await ensureConnected(ctx);
        // If we got here via "already paired", we haven't sent stop-stream yet.
        if (!stopStreamSent) {
          await sendStopStream();
        }
        return;
      }

      case 'preparing_stream': {
        await ensureConnected(ctx);
        const payload = new DjiPreparingToLivestreamMessagePayload();
        await write(
          new DjiMessage(
            preparingToLivestreamTarget,
            preparingToLivestreamTransactionId,
            preparingToLivestreamType,
            payload.encode(),
          ),
        );
        return;
      }

      case 'setting_up_wifi': {
        await ensureConnected(ctx);
        if (!ctx.wifiSsid || !ctx.wifiPassword) throw new Error('Missing wifi credentials');
        const payload = new DjiSetupWifiMessagePayload(ctx.wifiSsid, ctx.wifiPassword);
        await write(new DjiMessage(setupWifiTarget, setupWifiTransactionId, setupWifiType, payload.encode()));
        return;
      }

      case 'configuring': {
        await ensureConnected(ctx);
        if (!ctx.imageStabilization) throw new Error('Missing stabilization setting');
        const oa5 = ctx.model === DjiDeviceModel.osmoAction5Pro;
        const payload = new DjiConfigureMessagePayload(ctx.imageStabilization, oa5);
        await write(new DjiMessage(configureTarget, configureTransactionId, configureType, payload.encode()));
        return;
      }

      case 'starting_stream': {
        await ensureConnected(ctx);
        if (!ctx.rtmpUrl || !ctx.resolution) throw new Error('Missing stream config');
        const oa5 = ctx.model === DjiDeviceModel.osmoAction5Pro;
        const payload = new DjiStartStreamingMessagePayload(
          ctx.rtmpUrl,
          ctx.resolution,
          ctx.fps ?? 30,
          (ctx.bitrate ?? 6_000_000) / 1000,
          oa5,
        );
        await write(new DjiMessage(startStreamingTarget, startStreamingTransactionId, startStreamingType, payload.encode()));

        if (oa5) {
          const confirm = new DjiConfirmStartStreamingMessagePayload();
          await write(new DjiMessage(stopStreamingTarget, stopStreamingTransactionId, stopStreamingType, confirm.encode()));
        }
        return;
      }

      case 'streaming': {
        // Stop start-timeout once streaming begins.
        if (startTimer) {
          window.clearTimeout(startTimer);
          startTimer = undefined;
        }
        return;
      }

      case 'stopping_stream': {
        await ensureConnected(ctx);
        if (!stopTimer) {
          stopTimer = window.setTimeout(
            () => store.send({ type: 'stop_timeout_expired' } as unknown as { type: string }),
            stopTimeoutMs,
          );
        }
        await sendStopStream();
        return;
      }

      case 'idle': {
        cleanup();
        return;
      }
    }
  };

  const sub = store.subscribe((snapshot) => {
    const ctx = snapshot.context as unknown as DjiDeviceContext;
    const state = ctx.state;
    if (state === lastState) return;
    lastState = state;
    // Fire-and-forget effects, route failures back into store.
    void handleStateEntry(ctx, state).catch((error) => {
      store.send({
        type: 'error',
        error: { message: error instanceof Error ? error.message : String(error), cause: error },
      } as unknown as { type: string });
    });
  });

  return {
    stop(): void {
      sub.unsubscribe();
      cleanup();
    },
  };
}

