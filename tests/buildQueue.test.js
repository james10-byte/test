import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BuildQueue } from '../backend/src/queue/buildQueue.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('respects worker concurrency and processes every job', async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const queue = new BuildQueue({
    concurrency: 2,
    maxQueued: 10,
    timeoutMs: 5000,
    runner: async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(20);
      active -= 1;
      completed.push(id);
    }
  });
  for (const id of ['a', 'b', 'c', 'd', 'e']) queue.enqueue(id);
  await queue.onIdle();
  assert.equal(peak, 2);
  assert.deepEqual(completed.sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('rejects new jobs when the queue is full', async () => {
  const queue = new BuildQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 5000, runner: async () => delay(30) });
  queue.enqueue('a');
  queue.enqueue('b');
  assert.throws(() => queue.enqueue('c'), (error) => error.code === 'queue_full' && error.status === 429);
  await queue.onIdle();
});

test('reports queue positions and cancels queued jobs', async () => {
  const started = [];
  const queue = new BuildQueue({
    concurrency: 1,
    maxQueued: 10,
    timeoutMs: 5000,
    runner: async (id) => {
      started.push(id);
      await delay(30);
    }
  });
  queue.enqueue('a');
  queue.enqueue('b');
  queue.enqueue('c');
  assert.equal(queue.position('b'), 2);
  assert.equal(queue.position('c'), 3);
  assert.equal(queue.cancel('b'), 'removed');
  assert.equal(queue.position('c'), 2);
  assert.equal(queue.cancel('missing'), 'unknown');
  await queue.onIdle();
  assert.deepEqual(started, ['a', 'c']);
});

test('cancelling a running job aborts its signal', async () => {
  let reason;
  const queue = new BuildQueue({
    concurrency: 1,
    maxQueued: 10,
    timeoutMs: 5000,
    runner: (id, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          reason = signal.reason;
          resolve();
        });
      })
  });
  queue.enqueue('a');
  await delay(10);
  assert.equal(queue.isRunning('a'), true);
  assert.equal(queue.cancel('a'), 'aborted');
  await queue.onIdle();
  assert.equal(reason.name, 'AbortError');
});

test('jobs are aborted with a timeout reason when they run too long', async () => {
  let reason;
  const queue = new BuildQueue({
    concurrency: 1,
    maxQueued: 10,
    timeoutMs: 40,
    runner: (id, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          reason = signal.reason;
          resolve();
        });
      })
  });
  queue.enqueue('slow');
  await queue.onIdle();
  assert.equal(reason.name, 'TimeoutError');
});

test('a failing job does not stop the queue and is reported', async () => {
  const failures = [];
  const completed = [];
  const queue = new BuildQueue({
    concurrency: 1,
    maxQueued: 10,
    timeoutMs: 5000,
    onError: (id, error) => failures.push([id, error.message]),
    runner: async (id) => {
      if (id === 'bad') throw new Error('exploded');
      completed.push(id);
    }
  });
  queue.enqueue('bad');
  queue.enqueue('good');
  await queue.onIdle();
  assert.deepEqual(failures, [['bad', 'exploded']]);
  assert.deepEqual(completed, ['good']);
  assert.deepEqual(queue.size, { queued: 0, running: 0 });
});
