import type { Bytes } from './bytes.js';

export class ByteBuf {
  private readonly view: DataView;
  private offset = 0;

  static from(source: BufferSource): ByteBuf {
    const buffer = source instanceof ArrayBuffer ? source : source.buffer;
    const byteOffset = source instanceof ArrayBuffer ? 0 : source.byteOffset;
    const byteLength = source instanceof ArrayBuffer ? source.byteLength : source.byteLength;
    return new ByteBuf(buffer, byteOffset, byteLength);
  }

  constructor(buffer: ArrayBuffer, byteOffset = 0, byteLength?: number) {
    this.view = new DataView(buffer, byteOffset, byteLength);
  }

  get bytesRemaining(): number {
    return this.view.byteLength - this.offset;
  }

  readUint8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readUint16le(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readUint24le(): number {
    const b0 = this.view.getUint8(this.offset);
    const b1 = this.view.getUint8(this.offset + 1);
    const b2 = this.view.getUint8(this.offset + 2);
    this.offset += 3;
    return b0 | (b1 << 8) | (b2 << 16);
  }

  readBytes(length: number): Bytes {
    if (length > this.bytesRemaining) {
      throw new Error('EOF');
    }
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    // copy, so callers aren't tied to the underlying buffer lifetime
    return out.slice();
  }
}
