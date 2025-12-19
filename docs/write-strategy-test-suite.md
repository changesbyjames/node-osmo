## Write strategy (with a focus on a test suite)

### Why this matters
Starting/stopping streaming and configuring the camera relies on writing DJI frames to a writable GATT characteristic (currently `fff3`). In practice, BLE write behavior differs across:
- OS BLE stacks
- noble vs Web Bluetooth
- negotiated MTU / effective payload size
- peripheral characteristic properties

A reliable port needs a configurable write strategy and a test suite that validates the strategy logic independent of real hardware.

---

## Write strategy surface area

### Variables you must plan to tune
- **write mode**:
  - `write_without_response` (higher throughput, less backpressure)
  - `write_with_response` (more reliable, slower)
- **chunk_size**:
  - common safe default is 20 bytes
  - many setups support larger (e.g. 64–244), but it varies
- **pacing**:
  - delay between chunks (0ms, 5ms, 10ms, adaptive)
- **retry policy**:
  - retry count and backoff on transient write failures
- **in_flight control**:
  - max concurrent writes (usually 1)

### Recommended: make it explicit as a `write_profile`
Define a small set of named profiles, for example:
- `conservative`:
  - with_response
  - chunk_size=20
  - pacing=5–10ms
  - retries=2
- `balanced`:
  - without_response
  - chunk_size=20–64
  - pacing=0–2ms
  - retries=1
- `fast`:
  - without_response
  - chunk_size=max_supported
  - pacing=0ms
  - retries=0

Keep `write_profile` in configuration so you can switch it without code changes.

---

## Required component: `write_message()` implementation

### Responsibilities
- Accept a full encoded frame as `Uint8Array`.
- Split into chunks according to profile.
- Write chunks sequentially.
- Surface precise errors:
  - `write_failed` (transport error)
  - `write_timeout` (no completion)
  - `device_disconnected`

### Practical notes
- Web Bluetooth offers both `writeValueWithResponse` and `writeValueWithoutResponse` (if supported by the characteristic).
- Some peripherals accept only one mode.
- Some stacks behave better if you always use “with response” for long, chunked writes.

---

## Test suite design (no hardware required)

### Principle
Write tests against a **mock transport** with deterministic behavior and fault injection.

You’re testing:
- correctness of chunking
- sequencing and pacing logic
- retries/backoff
- mode selection and fallbacks
- error propagation
- cancellation handling (stop/reset)

### Mock transport interface (shape)
Model the transport as:
- `write_with_response(chunk: Uint8Array): Promise<void>`
- `write_without_response(chunk: Uint8Array): Promise<void>`

The mock records each call:
- `mode` used
- bytes written
- timestamps (optional)

And supports injected behaviors:
- fail on specific chunk index
- fail if chunk_size > limit
- random transient failure rate
- artificial latency per write
- disconnect mid-write

### Core tests to implement

#### 1) Chunking correctness
- **Given** a message of length `N`
- **When** `chunk_size = K`
- **Then** writes occur with exact chunks:
  - `ceil(N/K)` calls
  - concatenation of all chunks equals original message

Include edge cases:
- `N == K`
- `N == K+1`
- `N < K`
- `K == 1`

#### 2) Mode selection
- **Given** profile `write_with_response`
- **Then** only `write_with_response` is used

Same for `write_without_response`.

#### 3) Fallback behavior (optional but recommended)
If you implement fallback:
- try `write_without_response` first
- on “not supported”, fall back to `with_response`

Test:
- mock throws a specific `not_supported` error for without-response
- writer retries using with-response and succeeds

#### 4) Pacing
If you implement pacing:
- use fake timers
- assert minimum spacing between write calls

#### 5) Retry and backoff
- **Given** transient failures on chunk `i`
- **Then** chunk `i` is retried up to `retries` and succeeds

Also test:
- permanent failure exceeds retries and surfaces error
- retries do not duplicate earlier successful chunks

#### 6) Cancellation
- **Given** a multi-chunk write in progress
- **When** `stop_requested` or `reset` occurs
- **Then**:
  - remaining chunks are not written
  - the writer resolves/rejects with a cancellation error you can handle

#### 7) Disconnection mid-write
- mock throws `device_disconnected` on chunk `i`
- assert error classification and that no further writes occur

#### 8) Max-in-flight enforcement
If your writer guards concurrency:
- run two `write_message()` calls concurrently
- ensure they serialize or second fails predictably

### Property-style test (high value)
Generate random message lengths and chunk sizes within bounds:
- assert “written bytes == original bytes” for success cases
- assert “no extra bytes” on error/cancel cases

---

## Integration tests (optional, behind a flag)
Hardware-based tests are valuable but should be optional.

### Suggested structure
- `WRITE_PROFILE=conservative` default
- A script/test that:
  - connects to a real device
  - writes a harmless command
  - verifies an expected response via the framing layer

Keep this out of CI unless you have dedicated hardware runners.

---

## Metrics to log in production (to tune the strategy)
- selected `write_profile`
- average chunk latency
- retry count
- failures by category
- disconnect frequency

These metrics are what let you move from `conservative` to `balanced` confidently.

---

## Acceptance criteria
- Unit tests cover chunking, mode selection, retries, pacing, cancellation.
- The writer is deterministic and configurable via `write_profile`.
- The state machine never needs to know about chunking; it just calls `write_message(frame)`.
