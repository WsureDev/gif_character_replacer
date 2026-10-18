import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageQueue, QueueCancelled } from '../src/image-queue.js';

test('image concurrency is shared across tasks and changes without aborting active requests', async () => {
  const queue = new ImageQueue();
  assert.equal(queue.limit, 2);
  const a = await queue.acquire('task-a', 0), b = await queue.acquire('task-b', 0);
  const cPromise = queue.acquire('task-a', 1), dPromise = queue.acquire('task-c', 0);
  assert.equal(queue.snapshot().running, 2); assert.equal(queue.snapshot().pending, 2);
  queue.setLimit(3); const c = await cPromise;
  assert.equal(queue.snapshot().running, 3); assert.equal(queue.snapshot().pending, 1);
  queue.setLimit(1); a(); b();
  assert.equal(queue.snapshot().running, 1); assert.equal(queue.snapshot().pending, 1);
  c(); const d = await dPromise;
  assert.equal(queue.snapshot().running, 1); d();
  queue.setLimit(120); assert.equal(queue.limit, 120);
  assert.throws(() => queue.setLimit(121)); assert.throws(() => queue.setLimit(0));
});

test('a failed task cancels only its unsent images, leaving other tasks and active images intact', async () => {
  const queue = new ImageQueue(1), running = await queue.acquire('a', 0, 'worker-a');
  const cancelled = queue.acquire('a', 1, 'worker-a');
  const other = queue.acquire('b', 0, 'worker-b');
  const rejection = assert.rejects(cancelled, QueueCancelled);
  queue.cancelPending('a'); await rejection;
  assert.equal(queue.snapshot().running, 1); assert.equal(queue.snapshot().pending, 1);
  queue.detachOwner('worker-a'); running();
  const release = await other; assert.equal(queue.snapshot().running, 1); release();
  assert.equal(queue.snapshot().running, 0);
});
