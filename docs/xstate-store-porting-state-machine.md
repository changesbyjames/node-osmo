## Porting the `DjiDevice` state machine to `@xstate/store`

### Why `@xstate/store` fits this repo
The current implementation in `src/device.ts` is already a **single state machine** driven by:
- A finite **state enum** (`DjiDeviceState`)
- A mutable set of **context fields** (wifi, rtmpUrl, resolution/fps/bitrate, model, battery, etc.)
- **Events** that arrive from BLE notifications and timers
- **Side effects** (connect, discover services/characteristics, subscribe, write messages)

`@xstate/store` provides:
- A small, event-driven store with typed events.
- Pure transition functions (`on: { eventName: (...) => newContext }`).
- Subscription hooks to run effects in response to state changes.

Important: `@xstate/store` is **not** XState machines/statecharts. It does not model states explicitly for you; you model them yourself in the `context` (e.g. `context.state = 'connecting'`). This still works well here because `device.ts` already uses a homegrown state enum.

This guide uses **snake_case** for:
- **state strings** (e.g. `checking_if_paired`)
- **event names** (e.g. `start_requested`)

---

## Recommended architecture

### Split the system into 3 layers
1. **Protocol layer (pure)**
   - Message encoding/decoding (`DjiMessage`, payload builders)
   - Frame parsing / reassembly (recommended)
   - No IO.

2. **State/store layer (mostly pure)**
   - Holds state (`idle | discovering | connecting | ...`) and context.
   - Reduces incoming events into context updates.

3. **Transport/effects layer (impure)**
   - Noble transport (Node) and Web Bluetooth transport (browser).
   - Implements connect/discover/subscribe/write.
   - Emits typed events back into the store.

This keeps `@xstate/store` as the “truth” for state, while IO is delegated.

---

## Mapping today’s `device.ts` to a store

### 1) Model the finite state explicitly in context
Create a string union (or enum) mirroring `DjiDeviceState`:

- `idle`
- `discovering`
- `connecting`
- `checking_if_paired`
- `pairing`
- `cleaning_up`
- `preparing_stream`
- `setting_up_wifi`
- `configuring`
- `starting_stream`
- `streaming`
- `stopping_stream`

Store context should include:
- **state**: current state value
- **device selection**: browser `BluetoothDevice` (or a stable app-level id), plus model selection
- **transport handles**: characteristic references should NOT live in store context if you want the store serializable; instead keep them in the transport layer and refer to them by logical names (e.g. “fff3 write characteristic”).
- **settings**: wifiSsid, wifiPassword, rtmpUrl, resolution, fps, bitrate, stabilization
- **runtime**: batteryPercentage, lastError, lastMessage, timers active flags, etc.

### 2) Convert “methods” into events
In `device.ts`, imperative methods are:
- `startLiveStream(...)`
- `stopLiveStream()`
- internal timers firing
- BLE lifecycle callbacks (stateChange, discover, characteristic data)

In store form, these become events, for example:
- `start_requested({ wifi_ssid, wifi_password, rtmp_url, resolution, fps, bitrate, image_stabilization, model, device_ref? })`
- `stop_requested()`
- `start_timeout_expired()`
- `stop_timeout_expired()`
- `transport_ready()` / `transport_error({ error })`
- `connected()` / `disconnected()`
- `characteristics_ready({ has_fff3, has_fff4, has_fff5, ... })`
- `notification({ characteristic: 'fff4' | 'fff5' | 'fff0' | 'fff3', data: Uint8Array })`
- `message_received({ message: DjiMessage })` (recommended as the post-parse event)

You can keep both `notification` and `message_received` events:
- Transport emits `notification`.
- Protocol parser listens and emits `message_received` once a full valid frame is assembled.

### 3) Convert `setState(...)` into transitions
`device.ts` calls `setState(DjiDeviceState.X)` in many places. In store form, transitions set `context.state = 'X'`.

`@xstate/store` encourages you to update context in event transitions. For example, `start_requested` updates configuration and sets `state: 'discovering'`.

### 4) Move side effects out of transitions
Transition functions should stay pure. IO should happen in one of these patterns:

#### Pattern A: “Effect runner” subscribed to store
- Subscribe to store snapshots.
- Detect meaningful changes (state edges) and run effects.

Example edges:
- `idle → discovering`: begin transport initialization and device selection.
- `discovering → connecting`: connect and discover services/characteristics.
- `connecting → checking_if_paired`: write pair message.
- `setting_up_wifi → configuring`: write configure message.
- `configuring → starting_stream`: write start-stream message.

This is the closest match to the current state-machine style.

#### Pattern B: Effects triggered by explicit commands
- UI/consumer code calls functions that both `store.send(...)` and run transport operations.
- This is simpler but can leak side effects across layers.

For this repo, **Pattern A is recommended**.

---

## Concrete store design (recommended event and context shapes)

### Context
- `state: 'idle' | ...`
- `model: DjiDeviceModel` and `modelName`
- `device`: browser `BluetoothDevice` or node peripheral id string (abstracted)
- `pairPinCode: string`
- `wifiSsid?`, `wifiPassword?`, `rtmpUrl?`
- `resolution`, `fps`, `bitrate`, `imageStabilization`
- `batteryPercentage?`
- `error?: { message: string; cause?: unknown }`

### Events
Group them into:
- **Public API events**
  - `start_requested(...)`
  - `stop_requested()`
  - `set_pair_pin_code({ pin_code })`

- **Transport lifecycle events**
  - `transport_powered_on()` (node) / `device_chosen({ device })` (web)
  - `connected()` / `disconnected()`
  - `characteristics_discovered({ available: string[] })`
  - `write_failed({ error })`

- **Data events**
  - `bytes_received({ from: 'fff4' | 'fff5' | ..., bytes })`
  - `message_received({ message })`

- **Timer events**
  - `start_timeout_expired()`
  - `stop_timeout_expired()`

---

## Porting the existing state progression
Below is the logic in `device.ts`, rewritten as store-driven rules.

### Bootstrapping / start
- On `start_requested`:
  - set config in context
  - set `state = 'discovering'`
  - start a “start timeout” (60s)

**Effect runner** sees `state === 'discovering'`:
- Web:
  - if no `device` yet, trigger UI flow to choose device (or require `device_chosen` before start).
  - once device chosen, connect.
- Node:
  - start scanning and wait for matching device.

### Connecting and subscription
- Once connected and characteristics subscribed:
  - emit `connected` and `characteristics_discovered`
  - set `state = 'connecting'`

### Pairing initiation (current behavior)
Current logic: first time a value arrives on `fff4` while `connecting`, send pair message.

In store form:
- On `bytes_received(from: 'fff4')` in `state === 'connecting'`:
  - set `state = 'checking_if_paired'`
  - effect runner sends pair message immediately (or transition emits a “sendPair” command event).

### Checking if paired
- On `message_received` when `state === 'checking_if_paired'` and `message.id === pairTransactionId`:
  - if payload `[0, 1]`: proceed to cleanup
  - else: set `state = 'pairing'`

### Pairing / cleanup
Current logic: `processPairing()` immediately sends stop stream and moves to `cleaningUp`.

In store form:
- On entering `pairing` (or directly on the `checkingIfPaired` response):
  - effect runner sends stop-stream
  - set `state = 'cleaning_up'`

### Preparing stream
- On `message_received` in `cleaning_up` when `message.id === stopStreamingTransactionId`:
  - send preparing-to-livestream message
  - set `state = 'preparing_stream'`

### Setting up Wi‑Fi
- On `message_received` in `preparing_stream` when `message.id === preparingToLivestreamTransactionId`:
  - send setup-wifi message
  - set `state = 'setting_up_wifi'`

### Configuring vs starting directly
- On `message_received` in `setting_up_wifi` when `message.id === setupWifiTransactionId`:
  - if model requires configure step: send configure and set `state = 'configuring'`
  - else: send start-stream and set `state = 'starting_stream'`

### Starting stream
- On entering `starting_stream`:
  - send start-stream
  - OA5P: send confirm-start-stream payload
- On `message_received` in `starting_stream` when `message.id === startStreamingTransactionId`:
  - set `state = 'streaming'`
  - stop “start timeout”

### Streaming updates
- On `message_received` in `streaming`:
  - if battery message: update `batteryPercentage`

### Stop
- On `stop_requested`:
  - stop “start timeout”
  - start “stop timeout” (10s)
  - send stop-stream
  - set `state = 'stopping_stream'`

- On `message_received` in `stopping_stream` when `message.id === stopStreamingTransactionId`:
  - reset context and set `state = 'idle'`

- On `stop_timeout_expired`: force reset and set `state = 'idle'`

---

## Handling timers cleanly
`@xstate/store` doesn’t manage timers for you. Recommended:
- Keep timers in the **effect runner** (outside the store).
- When a timer fires, dispatch an event back into the store.

This avoids storing timer handles in context (which makes snapshots non-serializable).

---

## Transport integration points

### Web Bluetooth
- Device selection must come from user gesture. Recommended:
  - UI calls `store.send({ type: 'start_requested', ... })`
  - effect runner sees `state='discovering'` and requests a device if none exists
  - when chosen, dispatch `device_chosen({ device })`

### Node noble
- Effect runner starts scanning and dispatches:
  - `deviceDiscovered` (optional)
  - `connected` when peripheral connected
  - `bytesReceived` on characteristic data

---

## Testing strategy
- **Pure tests** (fast): feed the store a sequence of events and assert `context.state` transitions.
- **Transport simulation**: use a mock transport that emits `bytes_received` and captures writes.
- **Parser tests**: validate that fragmented notification sequences yield correct `message_received` events.

---

## Deliverable checklist for an implementation PR
- A new `djiDeviceStore` built with `createStore({ context, on })`.
- A transport-agnostic effect runner that:
  - reacts to state changes
  - manages timers
  - calls the transport
- A Web Bluetooth transport implementation.
- A Node noble transport implementation (wrapping existing behavior).
- A robust frame reassembly parser between `bytes_received` and `message_received`.
