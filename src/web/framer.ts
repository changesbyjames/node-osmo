import type { Bytes } from './bytes.js';
import { DjiMessage } from './message.js';

export interface DjiFramerStats {
  frames_ok: number;
  frames_header_crc_error: number;
  frames_crc_error: number;
  frames_bad_length: number;
  frames_bad_version: number;
  bytes_dropped: number;
  sync_misses: number;
  buffer_resets: number;
}

export interface DjiFramerOptions {
  /**
   * Hard cap to avoid unbounded memory usage if the stream is garbage.
   * When exceeded, the framer will drop bytes until it can resync.
   */
  maxBufferBytes?: number;
}

const MIN_FRAME_LENGTH = 13;
const MAX_FRAME_LENGTH = 0xff;

export class DjiFramer {
  private buffer = new Uint8Array(0);
  private stats: DjiFramerStats = {
    frames_ok: 0,
    frames_header_crc_error: 0,
    frames_crc_error: 0,
    frames_bad_length: 0,
    frames_bad_version: 0,
    bytes_dropped: 0,
    sync_misses: 0,
    buffer_resets: 0,
  };

  private readonly maxBufferBytes: number;

  constructor(options: DjiFramerOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? 4096;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
    this.stats.buffer_resets++;
  }

  getStats(): DjiFramerStats {
    return { ...this.stats };
  }

  push(chunk: Bytes): DjiMessage[] {
    if (chunk.byteLength === 0) return [];

    // Append
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;

    // Cap buffer growth (garbage stream protection)
    if (this.buffer.byteLength > this.maxBufferBytes) {
      // Drop everything except the last possible sync position window.
      // This is intentionally conservative: we keep up to MAX_FRAME_LENGTH bytes.
      const keep = Math.min(this.buffer.byteLength, MAX_FRAME_LENGTH);
      const dropped = this.buffer.byteLength - keep;
      this.buffer = this.buffer.subarray(dropped).slice();
      this.stats.bytes_dropped += dropped;
    }

    const messages: DjiMessage[] = [];

    // Parse loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const syncIndex = this.buffer.indexOf(0x55);
      if (syncIndex === -1) {
        this.stats.sync_misses++;
        this.stats.bytes_dropped += this.buffer.byteLength;
        this.buffer = new Uint8Array(0);
        break;
      }

      if (syncIndex > 0) {
        this.stats.bytes_dropped += syncIndex;
        this.buffer = this.buffer.subarray(syncIndex).slice();
      }

      if (this.buffer.byteLength < 2) break; // need length byte

      const length = this.buffer[1];
      if (length < MIN_FRAME_LENGTH || length > MAX_FRAME_LENGTH) {
        this.stats.frames_bad_length++;
        // Drop sync byte and resync.
        this.stats.bytes_dropped += 1;
        this.buffer = this.buffer.subarray(1).slice();
        continue;
      }

      if (this.buffer.byteLength < length) break; // wait for more bytes

      const frame = this.buffer.subarray(0, length);

      // Quick version check before doing deeper CRC work.
      if (frame[2] !== 0x04) {
        this.stats.frames_bad_version++;
        this.stats.bytes_dropped += 1;
        this.buffer = this.buffer.subarray(1).slice();
        continue;
      }

      try {
        const msg = DjiMessage.decodeFrame(frame);
        messages.push(msg);
        this.stats.frames_ok++;
        this.buffer = this.buffer.subarray(length).slice();
      } catch (error) {
        // Classify CRC errors best-effort by message text (decodeFrame throws typed strings).
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('header CRC')) {
          this.stats.frames_header_crc_error++;
        } else if (msg.includes('Calculated CRC')) {
          this.stats.frames_crc_error++;
        }
        // Drop 1 byte and retry (robust resync).
        this.stats.bytes_dropped += 1;
        this.buffer = this.buffer.subarray(1).slice();
      }
    }

    return messages;
  }
}

