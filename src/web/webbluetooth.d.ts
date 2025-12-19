// Minimal Web Bluetooth types for TypeScript.
// TypeScript's standard lib.dom.d.ts does not currently include Web Bluetooth.

export {};

declare global {
  type BluetoothServiceUUID = string | number;
  type BluetoothCharacteristicUUID = string | number;

  interface BluetoothRequestDeviceFilter {
    services?: BluetoothServiceUUID[];
    name?: string;
    namePrefix?: string;
  }

  interface RequestDeviceOptions {
    filters?: BluetoothRequestDeviceFilter[];
    optionalServices?: BluetoothServiceUUID[];
    acceptAllDevices?: boolean;
  }

  interface Bluetooth {
    requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
    getDevices?(): Promise<BluetoothDevice[]>;
  }

  interface Navigator {
    bluetooth: Bluetooth;
  }

  interface BluetoothDevice {
    id: string;
    name?: string;
    gatt?: BluetoothRemoteGATTServer;
  }

  interface BluetoothRemoteGATTServer {
    connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    getPrimaryService(uuid: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
    disconnect(): void;
  }

  interface BluetoothRemoteGATTService {
    getCharacteristic(uuid: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    uuid: string;
    value?: DataView;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    writeValueWithResponse(value: BufferSource): Promise<void>;
    writeValueWithoutResponse(value: BufferSource): Promise<void>;
  }
}

