import type { Bytes } from './bytes.js';
import { DJI_CHAR_FFF3, DJI_CHAR_FFF4, DJI_CHAR_FFF5, DJI_SERVICE_UUID } from './uuids.js';

export type DjiNotifySource = 'fff4' | 'fff5';

export interface WebBluetoothTransportOptions {
  serviceUuid?: BluetoothServiceUUID;
  /**
   * UUID of the write characteristic (DJI typically uses FFF3).
   */
  writeCharacteristicUuid?: BluetoothCharacteristicUUID;
  notifyCharacteristicUuids?: Partial<Record<DjiNotifySource, BluetoothCharacteristicUUID>>;
}

export interface ConnectedTransport {
  device: BluetoothDevice;
  disconnect(): void;

  onBytes(cb: (source: DjiNotifySource, bytes: Bytes) => void): () => void;

  writeWithResponse(chunk: Bytes): Promise<void>;
  writeWithoutResponse(chunk: Bytes): Promise<void>;
}

export class WebBluetoothTransport {
  private readonly serviceUuid: BluetoothServiceUUID;
  private readonly writeCharacteristicUuid: BluetoothCharacteristicUUID;
  private readonly notifyCharacteristicUuids: Record<DjiNotifySource, BluetoothCharacteristicUUID>;

  constructor(options: WebBluetoothTransportOptions = {}) {
    this.serviceUuid = options.serviceUuid ?? DJI_SERVICE_UUID;
    this.writeCharacteristicUuid = options.writeCharacteristicUuid ?? DJI_CHAR_FFF3;
    this.notifyCharacteristicUuids = {
      fff4: options.notifyCharacteristicUuids?.fff4 ?? DJI_CHAR_FFF4,
      fff5: options.notifyCharacteristicUuids?.fff5 ?? DJI_CHAR_FFF5,
    };
  }

  async requestDevice(): Promise<BluetoothDevice> {
    // Stable Web Bluetooth can’t scan; it uses a chooser. Filter by service UUID.
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [this.serviceUuid] }],
      optionalServices: [this.serviceUuid],
    });
  }

  async connect(device: BluetoothDevice): Promise<ConnectedTransport> {
    if (!device.gatt) {
      throw new Error('BluetoothDevice.gatt is not available');
    }
    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(this.serviceUuid);

    const writeChar = await service.getCharacteristic(this.writeCharacteristicUuid);
    const notifyChars: Partial<Record<DjiNotifySource, BluetoothRemoteGATTCharacteristic>> = {};

    for (const source of Object.keys(this.notifyCharacteristicUuids) as DjiNotifySource[]) {
      const uuid = this.notifyCharacteristicUuids[source];
      notifyChars[source] = await service.getCharacteristic(uuid);
    }

    const listeners = new Set<(source: DjiNotifySource, bytes: Bytes) => void>();
    const characteristicHandlers: Array<{
      characteristic: BluetoothRemoteGATTCharacteristic;
      handler: (ev: Event) => void;
    }> = [];

    for (const source of Object.keys(notifyChars) as DjiNotifySource[]) {
      const characteristic = notifyChars[source];
      if (!characteristic) continue;

      const handler = (ev: Event): void => {
        const c = ev.target as BluetoothRemoteGATTCharacteristic;
        const dv = c.value;
        if (!dv) return;
        const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
        for (const l of listeners) l(source, bytes);
      };
      characteristic.addEventListener('characteristicvaluechanged', handler);
      characteristicHandlers.push({ characteristic, handler });
      await characteristic.startNotifications();
    }

    const disconnect = (): void => {
      for (const { characteristic, handler } of characteristicHandlers) {
        characteristic.removeEventListener('characteristicvaluechanged', handler);
      }
      try {
        gatt.disconnect();
      } catch {
        // ignore
      }
    };

    const onBytes = (cb: (source: DjiNotifySource, bytes: Bytes) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    };

    const writeWithResponse = async (chunk: Bytes): Promise<void> => {
      await writeChar.writeValueWithResponse(chunk);
    };

    const writeWithoutResponse = async (chunk: Bytes): Promise<void> => {
      // May throw if unsupported; our write strategy can fallback.
      await writeChar.writeValueWithoutResponse(chunk);
    };

    return {
      device,
      disconnect,
      onBytes,
      writeWithResponse,
      writeWithoutResponse,
    };
  }
}

