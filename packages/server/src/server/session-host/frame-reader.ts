import type { Readable } from "node:stream";

const NEWLINE = 0x0a;

export interface FrameReader {
  /** Applies to the frame in progress and every later frame, e.g. after authentication. */
  setMaxFrameBytes(bytes: number): void;
}

export interface FrameReaderOptions {
  maxFrameBytes: number;
  onFrame(frame: string): void;
  /** Called once when a frame exceeds the cap. Reading stops; the caller closes the stream. */
  onOversize(): void;
}

/**
 * Splits a byte stream into newline-delimited UTF-8 frames. Unlike readline, it never buffers
 * more than the cap of one frame, so a peer that withholds the newline cannot grow memory without
 * bound. Frames are delivered in order; a callback that closes the stream stops delivery.
 */
export function readFrames(input: Readable, options: FrameReaderOptions): FrameReader {
  let maxFrameBytes = options.maxFrameBytes;
  let partial: Buffer[] = [];
  let partialBytes = 0;
  let stopped = false;

  function stop(): void {
    stopped = true;
    partial = [];
    partialBytes = 0;
    options.onOversize();
  }

  input.on("data", (chunk: Buffer | string) => {
    if (stopped) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    while (!stopped && !input.destroyed) {
      const newline = bytes.indexOf(NEWLINE, start);
      if (newline === -1) break;
      const length = partialBytes + (newline - start);
      if (length > maxFrameBytes) {
        stop();
        return;
      }
      const tail = bytes.subarray(start, newline);
      const frame =
        partial.length === 0 ? tail : Buffer.concat([...partial, tail], partialBytes + tail.length);
      partial = [];
      partialBytes = 0;
      start = newline + 1;
      options.onFrame(frame.toString("utf8"));
    }
    if (stopped || input.destroyed || start >= bytes.length) return;
    const remainder = bytes.subarray(start);
    partialBytes += remainder.length;
    if (partialBytes > maxFrameBytes) {
      stop();
      return;
    }
    // Copy so a retained slice does not pin the whole socket chunk.
    partial.push(Buffer.from(remainder));
  });

  return {
    setMaxFrameBytes(bytes) {
      maxFrameBytes = bytes;
    },
  };
}
