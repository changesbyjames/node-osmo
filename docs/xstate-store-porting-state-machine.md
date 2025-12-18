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
- `checkingIfPaired`
- `pairing`
- `cleaningUp`
- `preparingStream`
- `settingUpWifi`
- `configuring`
- `startingStream`
- `streaming`
- `stoppingStream`

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
- `startRequested({ wifiSsid, wifiPassword, rtmpUrl, resolution, fps, bitrate, stabilization, model, deviceRef? })`
- `stopRequested()`
- `timerStartStreamingExpired()`
- `timerStopStreamingExpired()`
- `transportReady()` / `transportError({ error })`
- `connected()` / `disconnected()`
- `characteristicsReady({ hasFff3, hasFff4, hasFff5, ... })`
- `notification({ characteristic: 'fff4' | 'fff5' | 'fff0' | 'fff3', data: Uint8Array })`
- `messageReceived({ message: DjiMessage })` (recommended as the post-parse event)

You can keep both `notification` and `messageReceived` events:
- Transport emits `notification`.
- Protocol parser listens and emits `messageReceived` once a full valid frame is assembled.

### 3) Convert `setState(...)` into transitions
`device.ts` calls `setState(DjiDeviceState.X)` in many places. In store form, transitions set `context.state = 'X'`.

`@xstate/store` encourages you to update context in event transitions. For example, `startRequested` updates configuration and sets `state: 'discovering'`.

### 4) Move side effects out of transitions
Transition functions should stay pure. IO should happen in one of these patterns:

#### Pattern A: “Effect runner” subscribed to store
- Subscribe to store snapshots.
- Detect meaningful changes (state edges) and run effects.

Example edges:
- `idle → discovering`: begin transport initialization and device selection.
- `discovering → connecting`: connect and discover services/characteristics.
- `connecting → checkingIfPaired`: write pair message.
- `settingUpWifi → configuring`: write configure message.
- `configuring → startingStream`: write start-stream message.

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
  - `startRequested(...)`
  - `stopRequested()`
  - `setPairPinCode({ pinCode })`

- **Transport lifecycle events**
  - `transportPoweredOn()` (node) / `deviceChosen({ device })` (web)
  - `connected()` / `disconnected()`
  - `characteristicsDiscovered({ available: string[] })`
  - `writeFailed({ error })`

- **Data events**
  - `bytesReceived({ from: 'fff4' | 'fff5' | ..., bytes })`
  - `messageReceived({ message })`

- **Timer events**
  - `startTimeoutExpired()`
  - `stopTimeoutExpired()`

---

## Porting the existing state progression
Below is the logic in `device.ts`, rewritten as store-driven rules.

### Bootstrapping / start
- On `startRequested`:
  - set config in context
  - set `state = 'discovering'`
  - start a “start timeout” (60s)

**Effect runner** sees `state === 'discovering'`:
- Web:
  - if no `device` yet, trigger UI flow to choose device (or require `deviceChosen` before start).
  - once device chosen, connect.
- Node:
  - start scanning and wait for matching device.

### Connecting and subscription
- Once connected and characteristics subscribed:
  - emit `connected` and `characteristicsDiscovered`
  - set `state = 'connecting'`

### Pairing initiation (current behavior)
Current logic: first time a value arrives on `fff4` while `connecting`, send pair message.

In store form:
- On `bytesReceived(from: 'fff4')` in `state === 'connecting'`:
  - set `state = 'checkingIfPaired'`
  - effect runner sends pair message immediately (or transition emits a “sendPair” command event).

### Checking if paired
- On `messageReceived` when `state === 'checkingIfPaired'` and `message.id === pairTransactionId`:
  - if payload `[0, 1]`: proceed to cleanup
  - else: set `state = 'pairing'`

### Pairing / cleanup
Current logic: `processPairing()` immediately sends stop stream and moves to `cleaningUp`.

In store form:
- On entering `pairing` (or directly on the `checkingIfPaired` response):
  - effect runner sends stop-stream
  - set `state = 'cleaningUp'`

### Preparing stream
- On `messageReceived` in `cleaningUp` when `message.id === stopStreamingTransactionId`:
  - send preparing-to-livestream message
  - set `state = 'preparingStream'`

### Setting up Wi‑Fi
- On `messageReceived` in `preparingStream` when `message.id === preparingToLivestreamTransactionId`:
  - send setup-wifi message
  - set `state = 'settingUpWifi'`

### Configuring vs starting directly
- On `messageReceived` in `settingUpWifi` when `message.id === setupWifiTransactionId`:
  - if model requires configure step: send configure and set `state = 'configuring'`
  - else: send start-stream and set `state = 'startingStream'`

### Starting stream
- On entering `startingStream`:
  - send start-stream
  - OA5P: send confirm-start-stream payload
- On `messageReceived` in `startingStream` when `message.id === startStreamingTransactionId`:
  - set `state = 'streaming'`
  - stop “start timeout”

### Streaming updates
- On `messageReceived` in `streaming`:
  - if battery message: update `batteryPercentage`

### Stop
- On `stopRequested`:
  - stop “start timeout”
  - start “stop timeout” (10s)
  - send stop-stream
  - set `state = 'stoppingStream'`

- On `messageReceived` in `stoppingStream` when `message.id === stopStreamingTransactionId`:
  - reset context and set `state = 'idle'`

- On `stopTimeoutExpired`: force reset and set `state = 'idle'`

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
  - UI calls `store.send({ type: 'startRequested', ... })`
  - effect runner sees `state='discovering'` and requests a device if none exists
  - when chosen, dispatch `deviceChosen({ device })`

### Node noble
- Effect runner starts scanning and dispatches:
  - `deviceDiscovered` (optional)
  - `connected` when peripheral connected
  - `bytesReceived` on characteristic data

---

## Testing strategy
- **Pure tests** (fast): feed the store a sequence of events and assert `context.state` transitions.
- **Transport simulation**: use a mock transport that emits `bytesReceived` and captures writes.
- **Parser tests**: validate that fragmented notification sequences yield correct `messageReceived` events.

---

## Deliverable checklist for an implementation PR
- A new `djiDeviceStore` built with `createStore({ context, on })`.
- A transport-agnostic effect runner that:
  - reacts to state changes
  - manages timers
  - calls the transport
- A Web Bluetooth transport implementation.
- A Node noble transport implementation (wrapping existing behavior).
- A robust frame reassembly parser between `bytesReceived` and `messageReceived`.
