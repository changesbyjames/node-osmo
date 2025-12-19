## Framing robustness (DJI message reassembly + validation)

### Why this matters
The current decoder (`DjiMessageWithData` in `src/message.ts`) assumes a single BLE notification contains exactly one complete DJI frame:
- First byte `0x55`
- Second byte `length`
- `data.length === length`

That assumption may hold on some stacks but is not safe to rely on across:
- different OS BLE stacks
- different write/notify characteristics
- Web Bluetooth vs noble
- firmware changes

To make the protocol portable and reliable, add a framing layer that can:
- handle **fragmentation** (one frame split across multiple notifications)
- handle **coalescing** (multiple frames in one notification)
- resync after **noise** / partial bytes / dropped chunks

---

## Frame format invariants (from existing code)
A valid DJI frame has:
- `sync`: `0x55` at byte 0
- `length`: byte 1 (total frame length)
- `version`: byte 2 must be `0x04`
- `header_crc8`: byte 3 equals CRC8 of bytes `[0..2]`
- `body` structure:
  - `[sync, length, version, header_crc8]`
  - `target` (2 bytes, LE)
  - `id` (2 bytes, LE)
  - `type` (3 bytes, LE)
  - `payload` (variable)
  - `crc16` (2 bytes, LE) equals CRC16 of all bytes except last 2

Minimum frame length is:
- header (4) + target (2) + id (2) + type (3) + crc16 (2) = **13 bytes**

---

## Recommended design: `DjiFramer`

### Responsibilities
- Accept arbitrary byte chunks from notifications: `push(bytes: Uint8Array)`
- Emit zero or more validated frames/messages
- Never throw on bad data; instead:
  - drop bytes until it can resync to the next plausible frame
  - collect stats for debugging

### Suggested API (shape)
- `push(bytes): DjiMessage[]`
  - returns parsed messages since last push
- `reset()`
- `get_stats()`
  - counts: `frames_ok`, `frames_crc_error`, `frames_header_crc_error`, `frames_bad_length`, `bytes_dropped`, `sync_misses`

### Parsing algorithm (robust)
1. Append `bytes` to an internal buffer.
2. Loop:
   - Search for `0x55` sync.
     - If not found: drop entire buffer.
     - If found at index `i > 0`: drop `i` bytes.
   - If buffer length < 2: break (need `length`).
   - Read `length`.
     - If `length < 13` or `length > MAX_FRAME_LENGTH`: drop 1 byte (advance past sync) and continue.
   - If buffer length < `length`: break (wait for more data).
   - Slice `frame = buffer[0:length]`.
   - Validate:
     - version byte
     - header CRC8
     - CRC16
   - If valid:
     - decode to `DjiMessage` (or keep `frame` bytes)
     - remove `length` bytes from buffer
   - If invalid:
     - drop 1 byte and continue (resync strategy)

Notes:
- `MAX_FRAME_LENGTH` can be conservative (e.g. 255) since `length` is a single byte.
- Resync-by-1-byte is slower but extremely robust.

---

## Test suite (required)

### What to test
You want tests that verify behavior under real BLE delivery patterns:

#### 1) Exact delivery
- **Given** a valid frame
- **When** pushed in one chunk
- **Then** exactly one message is emitted

#### 2) Fragmentation
- **Given** a valid frame
- **When** pushed as N fragments (split at arbitrary boundaries)
- **Then** no message emitted until final fragment, then exactly one message

Test with splits at:
- after sync byte
- after length byte
- mid-payload
- 1-byte chunks (worst case)

#### 3) Coalescing
- **Given** two valid frames `A`, `B`
- **When** pushed as `A || B` in one chunk
- **Then** two messages emitted in order

Also test `A || B || partial(C)` then `rest(C)`.

#### 4) Noise and resync
- **Given** garbage bytes + valid frame
- **When** pushed
- **Then** garbage is dropped and frame is parsed

Include garbage cases:
- random bytes without `0x55`
- bytes containing `0x55` but impossible `length`

#### 5) CRC failures
- **Given** a frame with a flipped bit (payload, header crc, or crc16)
- **Then** it is rejected and parser resyncs to next frame

#### 6) Buffer growth bounds
- **Given** a long stream of bytes with no valid frames
- **Then** the internal buffer does not grow unbounded

Implement a cap like:
- if buffer exceeds `N` (e.g. 4KB or 64KB), drop until next sync or reset.

### How to generate test vectors
- Use the existing encoder (`DjiMessage.encode()`) to generate canonical frames.
- Produce corrupted variants by flipping bytes.
- For fragmentation tests, split the `Uint8Array` at deterministic indices.

---

## Where it plugs into the system

### Node noble
- Characteristic `data` events provide `Buffer`.
- Convert to `Uint8Array` and push into `DjiFramer`.
- Emit `message_received` events to your state/store.

### Web Bluetooth
- `characteristicvaluechanged` provides a `DataView`.
- Convert to `Uint8Array` and push into `DjiFramer`.

---

## Acceptance criteria
- No parse failures when messages are fragmented/coalesced.
- Clear stats/logging when the stream contains invalid bytes.
- State machine receives a clean stream of validated messages and never deals with partial frames.
