export type Bytes = Uint8Array;

export function u8(value: number): Bytes {
  return Uint8Array.of(value & 0xff);
}

export function u16le(value: number): Bytes {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

export function u24le(value: number): Bytes {
  return Uint8Array.of(
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
  );
}

export function concatBytes(...parts: ReadonlyArray<Bytes>): Bytes {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function toHex(bytes: Bytes): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
