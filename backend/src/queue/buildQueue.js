import { AppError } from '../errors.js';

export class BuildQueue {
  #concurrency;
  #maxQueued;
  #timeoutMs;
  #runner;
  #onError;
  #pending = [];
  #running = new Map();
  #idleWaiters = [];

  constructor({ concurrency, maxQueued, timeoutMs, runner, onError }) {
    this.#concurrency = concurrency;
    this.#maxQueued = maxQueued;
    this.#timeoutMs = timeoutMs;
    this.#runner = runner;
    this.#onError = onError;
  }

  enqueue(id) {
    if (this.#pending.length >= this.#maxQueued) {
      throw new AppError(429, 'queue_full', 'The build queue is full. Please try again later.');
    }
    this.#pending.push(id);
    queueMicrotask(() => this.#pump());
  }

  position(id) {
    const index = this.#pending.indexOf(id);
    return index === -1 ? null : index + 1;
  }

  isRunning(id) {
    return this.#running.has(id);
  }

  get size() {
    return { queued: this.#pending.length, running: this.#running.size };
  }

  cancel(id) {
    const index = this.#pending.indexOf(id);
    if (index !== -1) {
      this.#pending.splice(index, 1);
      this.#notifyIdle();
      return 'removed';
    }
    const controller = this.#running.get(id);
    if (controller) {
      controller.abort(new DOMException('Build cancelled', 'AbortError'));
      return 'aborted';
    }
    return 'unknown';
  }

  onIdle() {
    if (this.#pending.length === 0 && this.#running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #notifyIdle() {
    if (this.#pending.length === 0 && this.#running.size === 0) {
      const waiters = this.#idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  #pump() {
    while (this.#running.size < this.#concurrency && this.#pending.length > 0) {
      const id = this.#pending.shift();
      const controller = new AbortController();
      this.#running.set(id, controller);
      const timer = setTimeout(
        () => controller.abort(new DOMException('Build timed out', 'TimeoutError')),
        this.#timeoutMs
      );
      this.#execute(id, controller.signal).finally(() => {
        clearTimeout(timer);
        this.#running.delete(id);
        this.#pump();
        this.#notifyIdle();
      });
    }
  }

  async #execute(id, signal) {
    try {
      await this.#runner(id, signal);
    } catch (error) {
      if (this.#onError) this.#onError(id, error);
    }
  }
}
