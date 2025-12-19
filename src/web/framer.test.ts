import { DjiFramer } from './framer.js';
import { DjiMessage } from './message.js';

function splitAt(bytes: Uint8Array, indices: number[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (const i of indices) {
    parts.push(bytes.subarray(start, i));
    start = i;
  }
  parts.push(bytes.subarray(start));
  return parts.filter((p) => p.byteLength > 0);
}

describe('DjiFramer', () => {
  test('parses one full frame delivered exactly', () => {
    const framer = new DjiFramer();
    const msg = new DjiMessage(0x0702, 0x8092, 0x450740, Uint8Array.of(1, 2, 3));
    const frame = msg.encode();

    const out = framer.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(msg.id);
    expect(out[0].target).toBe(msg.target);
    expect(out[0].type).toBe(msg.type);
    expect(Array.from(out[0].payload)).toEqual([1, 2, 3]);
  });

  test('parses one frame fragmented across many chunks', () => {
    const framer = new DjiFramer();
    const msg = new DjiMessage(0x0802, 0x8c12, 0xe10240, new Uint8Array(50).fill(0xab));
    const frame = msg.encode();

    const parts = splitAt(frame, [1, 2, 3, 7, 11, 20, 33, 49, 60].filter((i) => i < frame.length));
    const out: DjiMessage[] = [];
    for (const p of parts) out.push(...framer.push(p));

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(msg.id);
    expect(out[0].payload.byteLength).toBe(50);
  });

  test('parses multiple frames coalesced into a single chunk', () => {
    const framer = new DjiFramer();
    const a = new DjiMessage(0x0702, 0x1, 0x111111, Uint8Array.of(0xaa)).encode();
    const b = new DjiMessage(0x0702, 0x2, 0x222222, Uint8Array.of(0xbb, 0xbc)).encode();
    const chunk = new Uint8Array(a.length + b.length);
    chunk.set(a, 0);
    chunk.set(b, a.length);

    const out = framer.push(chunk);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(0x1);
    expect(out[1].id).toBe(0x2);
  });

  test('resyncs after noise bytes before a valid frame', () => {
    const framer = new DjiFramer();
    const noise = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x54, 0x56, 0x57]);
    const msg = new DjiMessage(0x0702, 0x1234, 0x450740, Uint8Array.of(9)).encode();
    const chunk = new Uint8Array(noise.length + msg.length);
    chunk.set(noise, 0);
    chunk.set(msg, noise.length);

    const out = framer.push(chunk);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(0x1234);
  });

  test('drops a CRC-broken frame and still parses the next one', () => {
    const framer = new DjiFramer();
    const good1 = new DjiMessage(0x0702, 0x1111, 0x450740, Uint8Array.of(1)).encode();
    const bad = new DjiMessage(0x0702, 0x2222, 0x450740, Uint8Array.of(2, 3, 4)).encode();
    const good2 = new DjiMessage(0x0702, 0x3333, 0x450740, Uint8Array.of(5)).encode();

    // Corrupt one byte in the payload (not the sync/length/version), leaving CRC inconsistent.
    const corrupted = bad.slice();
    corrupted[10] ^= 0xff;

    const chunk = new Uint8Array(good1.length + corrupted.length + good2.length);
    chunk.set(good1, 0);
    chunk.set(corrupted, good1.length);
    chunk.set(good2, good1.length + corrupted.length);

    const out = framer.push(chunk);
    expect(out.map((m) => m.id)).toEqual([0x1111, 0x3333]);

    const stats = framer.getStats();
    expect(stats.frames_ok).toBe(2);
    expect(stats.frames_crc_error + stats.frames_header_crc_error).toBeGreaterThanOrEqual(1);
  });
});

