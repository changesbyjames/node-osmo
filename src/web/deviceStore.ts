import { createStore } from '@xstate/store';
import { bytesEqual } from './bytes.js';
import type { Bytes } from './bytes.js';
import type { DjiMessage } from './message.js';
import type { DjiDeviceImageStabilization, DjiDeviceResolution } from './message.js';
import { DjiDeviceModel } from './deviceTypes.js';
import type { DjiNotifySource } from './transport.js';

const pairTransactionId = 0x8092;
const stopStreamingTransactionId = 0xeac8;
const preparingToLivestreamTransactionId = 0x8c12;
const setupWifiTransactionId = 0x8c19;
const startStreamingTransactionId = 0x8c2c;
const configureTransactionId = 0x8c2d;

export type DjiDeviceState =
  | 'idle'
  | 'discovering'
  | 'connecting'
  | 'checking_if_paired'
  | 'pairing'
  | 'cleaning_up'
  | 'preparing_stream'
  | 'setting_up_wifi'
  | 'configuring'
  | 'starting_stream'
  | 'streaming'
  | 'stopping_stream';

export interface DjiDeviceError {
  message: string;
  cause?: unknown;
}

export interface DjiDeviceContext {
  state: DjiDeviceState;

  model: DjiDeviceModel;
  device?: BluetoothDevice;

  pairPinCode: string;

  wifiSsid?: string;
  wifiPassword?: string;
  rtmpUrl?: string;
  resolution?: DjiDeviceResolution;
  fps?: number;
  bitrate?: number;
  imageStabilization?: DjiDeviceImageStabilization;

  batteryPercentage?: number;
  error?: DjiDeviceError;
}

// Event shapes (used via casts to keep the store transitions readable)
export type StartRequestedEvent = {
  type: 'start_requested';
  wifiSsid: string;
  wifiPassword: string;
  rtmpUrl: string;
  resolution: DjiDeviceResolution;
  fps: number;
  bitrate: number;
  imageStabilization: DjiDeviceImageStabilization;
  device?: BluetoothDevice;
};

export type SetPairPinCodeEvent = { type: 'set_pair_pin_code'; pinCode: string };
export type DeviceChosenEvent = { type: 'device_chosen'; device: BluetoothDevice };
export type BytesReceivedEvent = { type: 'bytes_received'; from: DjiNotifySource; bytes: Bytes };
export type MessageReceivedEvent = { type: 'message_received'; message: DjiMessage };
export type ErrorEvent = { type: 'error'; error: DjiDeviceError };

export function createDjiDeviceStore(initial: { model: DjiDeviceModel }): ReturnType<
  typeof createStore
> {
  return createStore({
    context: {
      state: 'idle',
      model: initial.model,
      pairPinCode: 'love',
    } as DjiDeviceContext,
    on: {
      start_requested: (ctx, ev) => {
        const e = ev as unknown as StartRequestedEvent;
        return {
          ...ctx,
          state: 'discovering',
          device: e.device ?? ctx.device,
          wifiSsid: e.wifiSsid,
          wifiPassword: e.wifiPassword,
          rtmpUrl: e.rtmpUrl,
          resolution: e.resolution,
          fps: e.fps,
          bitrate: e.bitrate,
          imageStabilization: e.imageStabilization,
          batteryPercentage: undefined,
          error: undefined,
        } as DjiDeviceContext;
      },

      set_pair_pin_code: (ctx, ev) => {
        const e = ev as unknown as SetPairPinCodeEvent;
        return { ...ctx, pairPinCode: e.pinCode } as DjiDeviceContext;
      },

      device_chosen: (ctx, ev) => {
        const e = ev as unknown as DeviceChosenEvent;
        if (ctx.state !== 'discovering') return ctx;
        return { ...ctx, device: e.device, state: 'connecting' } as DjiDeviceContext;
      },

      connected: (ctx) => {
        if (ctx.state !== 'connecting') return ctx;
        return ctx;
      },

      disconnected: (ctx) => ({
        ...ctx,
        state: 'idle',
        device: undefined,
        error: { message: 'Disconnected' },
      }) as DjiDeviceContext,

      bytes_received: (ctx, ev) => {
        const e = ev as unknown as BytesReceivedEvent;
        if (ctx.state === 'connecting' && e.from === 'fff4') {
          return { ...ctx, state: 'checking_if_paired' } as DjiDeviceContext;
        }
        return ctx;
      },

      message_received: (ctx, ev) => {
        const e = ev as unknown as MessageReceivedEvent;
        const msg = e.message;

        if (ctx.state === 'checking_if_paired' && msg.id === pairTransactionId) {
          if (bytesEqual(msg.payload, Uint8Array.of(0, 1))) {
            return { ...ctx, state: 'cleaning_up' } as DjiDeviceContext;
          }
          return { ...ctx, state: 'pairing' } as DjiDeviceContext;
        }

        if (ctx.state === 'cleaning_up' && msg.id === stopStreamingTransactionId) {
          return { ...ctx, state: 'preparing_stream' } as DjiDeviceContext;
        }

        if (ctx.state === 'preparing_stream' && msg.id === preparingToLivestreamTransactionId) {
          return { ...ctx, state: 'setting_up_wifi' } as DjiDeviceContext;
        }

        if (ctx.state === 'setting_up_wifi' && msg.id === setupWifiTransactionId) {
          if (ctx.model === DjiDeviceModel.osmoAction4 || ctx.model === DjiDeviceModel.osmoAction5Pro) {
            return { ...ctx, state: 'configuring' } as DjiDeviceContext;
          }
          return { ...ctx, state: 'starting_stream' } as DjiDeviceContext;
        }

        if (ctx.state === 'configuring' && msg.id === configureTransactionId) {
          return { ...ctx, state: 'starting_stream' } as DjiDeviceContext;
        }

        if (ctx.state === 'starting_stream' && msg.id === startStreamingTransactionId) {
          return { ...ctx, state: 'streaming' } as DjiDeviceContext;
        }

        if (ctx.state === 'stopping_stream' && msg.id === stopStreamingTransactionId) {
          return {
            ...ctx,
            state: 'idle',
            wifiSsid: undefined,
            wifiPassword: undefined,
            rtmpUrl: undefined,
            resolution: undefined,
            fps: undefined,
            bitrate: undefined,
            imageStabilization: undefined,
          } as DjiDeviceContext;
        }

        if (ctx.state === 'streaming' && msg.type === 0x020d00 && msg.payload.byteLength >= 21) {
          return { ...ctx, batteryPercentage: msg.payload[20] } as DjiDeviceContext;
        }

        return ctx;
      },

      pairing_initiated: (ctx) => {
        if (ctx.state !== 'pairing') return ctx;
        return { ...ctx, state: 'cleaning_up' } as DjiDeviceContext;
      },

      start_timeout_expired: (ctx) => ({
        ...ctx,
        state: 'idle',
        error: { message: 'Start timeout' },
      }) as DjiDeviceContext,

      stop_requested: (ctx) => {
        if (ctx.state === 'idle') return ctx;
        return { ...ctx, state: 'stopping_stream' } as DjiDeviceContext;
      },

      stop_timeout_expired: (ctx) => ({
        ...ctx,
        state: 'idle',
        error: { message: 'Stop timeout' },
      }) as DjiDeviceContext,

      error: (ctx, ev) => {
        const e = ev as unknown as ErrorEvent;
        return { ...ctx, state: 'idle', error: e.error } as DjiDeviceContext;
      },
    },
  });
}

export type DjiDeviceStore = ReturnType<typeof createDjiDeviceStore>;
