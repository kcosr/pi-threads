import { DaemonError } from "../errors.ts";

export const MAX_STREAM_BYTES = 4 * 1024 * 1024;

/** A single-consumer, bounded stream. Closing observation never cancels daemon work. */
export class BufferedStream<T> implements AsyncIterableIterator<T> {
  private readonly queue: Array<{ value: T; bytes: number }> = [];
  private bytes = 0;
  private ended = false;
  private error: unknown;
  private waiter:
    | { resolve: (item: IteratorResult<T>) => void; reject: (error: unknown) => void }
    | undefined;

  constructor(
    private readonly onClose: () => void = () => {},
    private readonly limit = MAX_STREAM_BYTES,
  ) {}

  get closed(): boolean {
    return this.ended;
  }

  push(value: T): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.bytes + bytes > this.limit) {
      this.fail(new DaemonError("streamOverflow", "Event stream buffer exceeded its byte limit"));
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value, done: false });
    } else {
      this.queue.push({ value, bytes });
      this.bytes += bytes;
    }
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.onClose();
    this.waiter?.resolve({ value: undefined, done: true });
    this.waiter = undefined;
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.error = error;
    this.queue.length = 0;
    this.bytes = 0;
    this.ended = true;
    this.onClose();
    this.waiter?.reject(error);
    this.waiter = undefined;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.error) return Promise.reject(this.error);
    const item = this.queue.shift();
    if (item) {
      this.bytes -= item.bytes;
      return Promise.resolve({ value: item.value, done: false });
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    if (this.waiter) return Promise.reject(new Error("Event streams support one consumer"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  async close(): Promise<void> {
    this.queue.length = 0;
    this.bytes = 0;
    this.finish();
  }

  async return(): Promise<IteratorResult<T>> {
    await this.close();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
