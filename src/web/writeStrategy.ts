import type { Bytes } from './bytes.js';

export type WriteMode = 'write_with_response' | 'write_without_response';

export interface WriteProfile {
  mode: WriteMode;
  chunkSize: number;
  pacingMs: number;
  retries: number;
}

export const writeProfiles = {
  conservative: {
    mode: 'write_with_response',
    chunkSize: 20,
    pacingMs: 8,
    retries: 2,
  },
  balanced: {
    mode: 'write_without_response',
    chunkSize: 32,
    pacingMs: 0,
    retries: 1,
  },
  fast: {
    mode: 'write_without_response',
    chunkSize: 64,
    pacingMs: 0,
    retries: 0,
  },
} as const satisfies Record<string, WriteProfile>;

export interface ChunkWriter {
  writeWithResponse?(chunk: Bytes): Promise<void>;
  writeWithoutResponse?(chunk: Bytes): Promise<void>;
}

export interface WriteMessageOptions {
  signal?: AbortSignal;
}

export class WriteCancelledError extends Error {
  constructor() {
    super('Write cancelled');
    this.name = 'WriteCancelledError';
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WriteCancelledError();
}

async function writeChunk(
  writer: ChunkWriter,
  chunk: Bytes,
  mode: WriteMode,
): Promise<void> {
  if (mode === 'write_without_response') {
    if (writer.writeWithoutResponse) return writer.writeWithoutResponse(chunk);
    if (writer.writeWithResponse) return writer.writeWithResponse(chunk);
    throw new Error('Transport does not support writing (no write methods)');
  }

  if (writer.writeWithResponse) return writer.writeWithResponse(chunk);
  if (writer.writeWithoutResponse) return writer.writeWithoutResponse(chunk);
  throw new Error('Transport does not support writing (no write methods)');
}

export async function writeMessage(
  writer: ChunkWriter,
  frame: Bytes,
  profile: WriteProfile,
  options: WriteMessageOptions = {},
): Promise<void> {
  if (profile.chunkSize <= 0) throw new Error('chunkSize must be > 0');

  const { signal } = options;
  const chunks: Bytes[] = [];
  for (let i = 0; i < frame.byteLength; i += profile.chunkSize) {
    chunks.push(frame.subarray(i, Math.min(frame.byteLength, i + profile.chunkSize)));
  }

  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    const chunk = chunks[i];
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await writeChunk(writer, chunk, profile.mode);
        break;
      } catch (error) {
        attempt++;
        if (attempt > profile.retries) throw error;
        // Small backoff; keep it simple for now.
        await sleep(Math.min(50, 5 * attempt));
      }
    }
    if (profile.pacingMs > 0 && i < chunks.length - 1) {
      await sleep(profile.pacingMs);
    }
  }
}

/**
 * Serializes calls to `writeMessage()` to avoid interleaved chunk writes.
 */
export class MessageWriter {
  private inFlight: Promise<void> = Promise.resolve();
  private readonly writer: ChunkWriter;
  private profile: WriteProfile;

  constructor(writer: ChunkWriter, profile: WriteProfile) {
    this.writer = writer;
    this.profile = profile;
  }

  setProfile(profile: WriteProfile): void {
    this.profile = profile;
  }

  write(frame: Bytes, options: WriteMessageOptions = {}): Promise<void> {
    this.inFlight = this.inFlight.then(() =>
      writeMessage(this.writer, frame, this.profile, options),
    );
    return this.inFlight;
  }
}

