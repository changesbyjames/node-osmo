## Web Bluetooth porting plan (hardest problems + attack plan)

### Goal
Port the library to run in the browser (Web Bluetooth) while preserving the DJI protocol/state-machine behavior, acknowledging that discovery/scanning and identity will be different.

### Core approach: split “protocol” from “transport”
Create a transport abstraction used by the state machine:
- **Transport responsibilities**: connect/disconnect, service/characteristic discovery, subscribe to notifications, write bytes.
- **Protocol responsibilities**: message framing/CRC, state machine, transaction sequencing, payload building/parsing.

Implement two transports:
- **Node transport**: wraps current `@stoprocent/noble` behavior.
- **Web transport**: wraps Web Bluetooth APIs.

This keeps the DJI-specific logic shared and confines platform differences to the transport layer.

---

## Hard problems and plan of attack

### 1) Discovery + “scanner replacement”
**Problem**
The current `DjiDeviceScanner` depends on passive scanning and advertisement manufacturer data, neither of which is available in stable Web Bluetooth.

**Plan**
- Replace scanning with a **user-driven connect flow**:
  - Provide a `requestDevice()` entry point.
  - Filter by GATT service UUID `0xFFF0` where possible.
- Model detection:
  - First iteration: **user selects model** (OA3/OA4/OA5P/Pocket3) after choosing the device.
  - Later iteration: attempt inference by:
    - device name patterns,
    - service/characteristic layout,
    - or a protocol-level “query model” message (if discoverable via reverse-engineering).

**Acceptance criteria**
- A user can pick a device in the chooser and proceed to connect successfully.

### 2) MTU/write-length limitations and fragmentation
**Problem**
Web Bluetooth doesn’t expose MTU well and write limits vary; the start-stream command includes a URL and can exceed small payload sizes.

**Plan**
- Implement **chunked writes** in the Web transport:
  - Start with conservative chunks (e.g., 20 bytes) for `writeValueWithoutResponse`.
  - Add ability to switch to `writeValueWithResponse` for reliability.
  - Tune chunk sizes empirically once a device is available.

**Acceptance criteria**
- Start-stream command succeeds reliably with typical RTMP URLs.

### 3) Notification framing and reassembly
**Problem**
Current decoder assumes each notification is exactly one full DJI frame. If the platform fragments/coalesces notifications, parsing fails.

**Plan**
- Add a **reassembly layer**:
  - Maintain a per-characteristic byte buffer.
  - Parse frames using: sync byte `0x55`, length byte, then wait until full frame present.
  - Validate CRCs before emitting a decoded message.

**Acceptance criteria**
- Parser can handle:
  - exact frame per event,
  - fragmented frames across multiple events,
  - multiple frames in one event.

### 4) Reconnect UX and permission persistence
**Problem**
Browser reconnection requires prior permission and differs across browsers.

**Plan**
- On Chromium, use `navigator.bluetooth.getDevices()` for previously-granted devices.
- Always keep a user-gesture “Reconnect” button.
- Fall back to chooser when remembered devices aren’t available.

**Acceptance criteria**
- User can reconnect without reselecting the device in Chrome after first pairing.

### 5) Remove Node-only primitives from shared core
**Problem**
Shared code uses Node `Buffer`, `EventEmitter`, and Node typings.

**Plan**
- Replace Buffer usage with `Uint8Array`-based helpers in protocol code.
- Replace EventEmitter for the web build with callbacks or `EventTarget`.
- Keep timers generic (`setTimeout`) without NodeJS typings in public surfaces.

---

## Implementation sequence (de-risk early)

### Phase 1: Prove Web Bluetooth connectivity
- `requestDevice()` → connect → discover `fff0` + `fff3/fff4/fff5` → start notifications → log raw bytes.

### Phase 2: Prove protocol parsing
- Port `DjiMessage` encoding/decoding to `Uint8Array`.
- Implement reassembly parser.

### Phase 3: Prove a simple command
- Pairing message write + validate expected response.

### Phase 4: Prove “big write” path
- Start-stream message with chunking; adjust write method/chunk sizes as needed.

### Phase 5: Productize
- Add reconnect support, model selection UX, and browser support notes (Chromium-first).
