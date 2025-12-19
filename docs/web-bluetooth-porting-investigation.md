## Web Bluetooth porting investigation for `node-osmo`

### Executive summary
This repo controls DJI Osmo Action 3/4/5 Pro and Pocket 3 over BLE using a GATT-based protocol (writes + notifications). That core behavior is **portable to the browser** via Web Bluetooth in **Chromium-based browsers** (Chrome/Edge on desktop and Android), but the current **scanner/discovery UX and device identification approach cannot be replicated 1:1** because stable Web Bluetooth does not expose passive scanning results or advertisement manufacturer data.

- **Possible (Chromium)**: connect via user chooser, discover services/characteristics, subscribe to notifications, write commands, run the same transaction/state machine (pair → wifi → configure → start RTMP), parse battery messages.
- **Not possible (stable Web Bluetooth)**: continuous scanning like noble, filtering by manufacturer data, enumerating nearby devices without the chooser, connecting by MAC address/peripheral id.

### Repo overview (what it does today)
- **BLE stack**: Node uses `@stoprocent/noble` and scans advertisements, connects, discovers services, subscribes to characteristics, and writes frames.
- **Protocol**: `src/message.ts` defines a framed message format with CRC8 (header) and CRC16 (body).
- **Primary feature flow**: `src/device.ts` runs a deterministic sequence of transactions to configure the camera and start/stop live streaming.

### Web Bluetooth constraints that matter
- **Secure context**: requires HTTPS (or localhost).
- **User gesture**: `navigator.bluetooth.requestDevice(...)` must be triggered by user interaction.
- **Discovery**: stable Web Bluetooth uses a chooser; you cannot passively scan and list all nearby devices like noble.
- **Advertisement data**: stable Web Bluetooth generally does **not** expose manufacturer data; you cannot use the current manufacturer-data model detection during discovery.
- **Identity**: browser `device.id` is opaque and origin-scoped; you cannot rely on noble-style `peripheral.id` or MAC.
- **GATT-only**: Web Bluetooth is GATT-oriented; no raw HCI.
- **MTU/write behavior**: MTU is not surfaced cleanly; larger writes may require manual chunking and careful use of “with response” vs “without response”.

---

## File-by-file analysis (line-by-line implications)

### `src/index.ts`
Exports scanner/device/enums. It exports `device` twice (duplication), but functionally harmless.

### `src/scanner.ts` (Node-only behavior)
**What it does**
- Starts scanning for all BLE advertisements.
- Reads `peripheral.advertisement.manufacturerData`.
- Filters for DJI manufacturer prefix and derives model.
- Emits `deviceDiscovered` with `Peripheral` + model/modelName.

**Browser feasibility**
- **Not portable as-is**: stable Web Bluetooth does not provide a background “discover” event stream or manufacturer data.

**Browser replacement**
- Replace scanning with a **user-driven chooser** using `requestDevice()` and filters by service UUID (`0xFFF0` / `fff0`) or by `namePrefix`.
- Device lists must be UX-driven (a button), not passive scanning.

### `src/model.ts` (manufacturer data parsing)
**What it does**
- Detects DJI by manufacturer bytes `[0xaa, 0x08]`.
- Maps bytes 2..3 to model codes.

**Browser feasibility**
- **Not directly usable for discovery** in stable Web Bluetooth due to lack of manufacturer data.

**Workarounds**
- Ask user to pick the model (initial approach).
- Infer from GATT layout or from a “query model” message (if the protocol supports it; not currently implemented here).
- Persist the user’s selection per device id once a device is chosen.

### `src/device.ts` (core state machine)
This is the highest-value code to preserve.

**What it does**
- Uses noble to scan until it sees a `peripheral.id` matching `deviceId`.
- Connects, discovers all services/characteristics.
- Subscribes to notifications for `fff0/fff3/fff4/fff5` and writes to `fff3`.
- On first message from `fff4` during `connecting`, sends the pair message and advances state.
- Proceeds through transactions keyed by constants (transaction id + target + type) to stop stream, prep, set up wifi, configure stabilization (model-specific), start streaming, and track battery status.

**Web Bluetooth mapping**
- **Connect/discover**: maps to `device.gatt.connect()`, `getPrimaryService('0000fff0-0000-1000-8000-00805f9b34fb')`, `getCharacteristic('...fff3...')`, etc.
- **Notifications**: maps to `characteristic.startNotifications()` and `characteristicvaluechanged` events.
- **Writes**: maps to `writeValueWithoutResponse()` / `writeValueWithResponse()`.

**Key incompatibilities to address**
- **Discovery**: cannot scan for a noble `peripheral.id`. Must start from a chosen `BluetoothDevice`.
- **Manufacturer data gating**: `onDiscover` checks manufacturer data; browser cannot.
- **Data types**: browser delivers `DataView` and `ArrayBuffer`, not Node `Buffer`.
- **Write sizes**: you may need manual chunking for frames that exceed the platform’s effective write limits.
- **Framing assumption**: `DjiMessageWithData` assumes each notification is exactly one full frame (length byte matches received length). If Web Bluetooth fragments/coalesces, implement reassembly.

### `src/message.ts` (framing + CRC)
**What it does**
- Encodes: `[0x55, length, 0x04, crc8] + target + id + type + payload + crc16`.
- Decodes: validates first byte, length, version, CRC8, CRC16.
- Builds payloads for pairing, wifi, start/stop streaming, and configuration.

**Browser feasibility**
- The algorithm is portable, but:
  - Replace `Buffer` usage with `Uint8Array` helpers.
  - Consider adding a streaming parser (reassembly buffer) so fragmented notifications can be handled.

### `src/bytebuf.ts` (DataView-based buffer helper)
**What it does**
- Implements a DataView wrapper with cursor-based reads and writes.

**Browser feasibility**
- Largely browser-compatible already.
- Minor Node-type leakage (`BufferEncoding`) should be removed or narrowed.
- Potential correctness bug: `writeInt24` advances offset by 4 even though 24-bit ints are 3 bytes.

### `src/enums.ts`
**What it does**
- Defines resolution, stabilization, model enums; provides bitrate and fps lists.

**Notes**
- `djiDeviceResolutions` is incorrectly derived from `DjiDeviceImageStabilization` values instead of `DjiDeviceResolution`.

---

## Feasibility conclusions

### What is most likely to work in a browser
- **Core command/control** (GATT writes + notifications) for pairing and starting/stopping streaming.
- **Battery parsing** (once messages are received).

### What cannot be matched 1:1
- **Automatic discovery and model detection** based on manufacturer data.
- **Connecting by stable peripheral id** without the chooser.

### Main technical risks
- **Write-size/MTU issues** for messages containing longer payloads (notably RTMP URL) and whether the camera expects chunking.
- **Notification framing** if messages are split across multiple notifications.
- **Browser support**: realistic target is Chromium; Safari/iOS coverage is not comparable.
