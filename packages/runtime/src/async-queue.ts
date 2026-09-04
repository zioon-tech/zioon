type IteratorWaiter<T> = {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
};

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: IteratorWaiter<T>[] = [];
  private closed = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false });
        }
        if (this.failure !== null) return Promise.reject(this.failure);
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      }
    };
  }
}
