import type { Bytes } from './bytes.js';
import {
  MessageWriter,
  type ChunkWriter,
  type WriteProfile,
  WriteCancelledError,
  writeMessage,
} from './writeStrategy.js';

class MockWriter implements ChunkWriter {
  calls: Array<{ mode: 'with' | 'without'; bytes: number[] }> = [];
  failOnCall?: number;
  private callIndex = 0;

  async writeWithResponse(chunk: Bytes): Promise<void> {
    this.calls.push({ mode: 'with', bytes: Array.from(chunk) });
    this.maybeFail();
  }

  async writeWithoutResponse(chunk: Bytes): Promise<void> {
    this.calls.push({ mode: 'without', bytes: Array.from(chunk) });
    this.maybeFail();
  }

  private maybeFail(): void {
    const idx = this.callIndex++;
    if (this.failOnCall === idx) {
      throw new Error(`Injected failure at call ${idx}`);
    }
  }
}

function flattenCalls(calls: Array<{ bytes: number[] }>): number[] {
  return calls.flatMap((c) => c.bytes);
}

describe('writeStrategy', () => {
  test('chunks correctly and preserves byte order', async () => {
    const w = new MockWriter();
    const frame = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const profile: WriteProfile = {
      mode: 'write_with_response',
      chunkSize: 3,
      pacingMs: 0,
      retries: 0,
    };

    await writeMessage(w, frame, profile);
    expect(w.calls).toHaveLength(4);
    expect(flattenCalls(w.calls)).toEqual(Array.from(frame));
  });

  test('uses with-response mode when configured', async () => {
    const w = new MockWriter();
    const frame = Uint8Array.from([1, 2, 3, 4]);
    const profile: WriteProfile = {
      mode: 'write_with_response',
      chunkSize: 2,
      pacingMs: 0,
      retries: 0,
    };

    await writeMessage(w, frame, profile);
    expect(w.calls.map((c) => c.mode)).toEqual(['with', 'with']);
  });

  test('uses without-response mode when configured', async () => {
    const w = new MockWriter();
    const frame = Uint8Array.from([1, 2, 3, 4]);
    const profile: WriteProfile = {
      mode: 'write_without_response',
      chunkSize: 2,
      pacingMs: 0,
      retries: 0,
    };

    await writeMessage(w, frame, profile);
    expect(w.calls.map((c) => c.mode)).toEqual(['without', 'without']);
  });

  test('falls back to with-response if without-response is unavailable', async () => {
    const calls: Array<{ mode: 'with'; bytes: number[] }> = [];
    const w: ChunkWriter = {
      writeWithResponse: async (chunk) => {
        calls.push({ mode: 'with', bytes: Array.from(chunk) });
      },
    };

    const frame = Uint8Array.from([1, 2, 3, 4, 5]);
    const profile: WriteProfile = {
      mode: 'write_without_response',
      chunkSize: 2,
      pacingMs: 0,
      retries: 0,
    };

    await writeMessage(w, frame, profile);
    expect(calls).toHaveLength(3);
    expect(flattenCalls(calls)).toEqual(Array.from(frame));
  });

  test('retries a failing chunk up to retries', async () => {
    const w = new MockWriter();
    w.failOnCall = 1; // fail the second write
    const frame = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    const profile: WriteProfile = {
      mode: 'write_with_response',
      chunkSize: 2,
      pacingMs: 0,
      retries: 1,
    };

    await writeMessage(w, frame, profile);
    // Calls: chunk0 ok, chunk1 fails, chunk1 retry ok, chunk2 ok => 4
    expect(w.calls).toHaveLength(4);
    expect(flattenCalls(w.calls)).toEqual([0, 1, 2, 3, 2, 3, 4, 5]);
  });

  test('supports cancellation via AbortSignal', async () => {
    const w = new MockWriter();
    const frame = new Uint8Array(100).fill(7);
    const profile: WriteProfile = {
      mode: 'write_with_response',
      chunkSize: 10,
      pacingMs: 0,
      retries: 0,
    };
    const ac = new AbortController();

    const p = writeMessage(w, frame, profile, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(WriteCancelledError);
  });

  test('MessageWriter serializes writes (no interleaving)', async () => {
    const w = new MockWriter();
    const profile: WriteProfile = {
      mode: 'write_with_response',
      chunkSize: 2,
      pacingMs: 0,
      retries: 0,
    };
    const mw = new MessageWriter(w, profile);

    const a = Uint8Array.from([1, 1, 1, 1]);
    const b = Uint8Array.from([2, 2, 2, 2]);

    await Promise.all([mw.write(a), mw.write(b)]);

    const flattened = flattenCalls(w.calls);
    // Must be either a then b, or b then a, but never interleaved.
    expect(
      flattened.join(',') === [...a, ...b].join(',') ||
        flattened.join(',') === [...b, ...a].join(','),
    ).toBe(true);
  });
});

