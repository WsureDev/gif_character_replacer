import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createLabServer } from '../src/web-server.js';
import { prepareDraft } from '../src/lab-jobs.js';
import { readTask, type Asset, type Task } from '../src/lab-store.js';
import { fixture } from './fixtures.js';

test('HTTP workflow persists offline previews and rejects stale or concurrent paid submissions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-web-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, 'config.env');
  await fs.writeFile(envFile, 'OPENAI_BASE_URL=https://example.invalid/v1\nOPENAI_API_KEY=private-web-test-key\nOPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst\nGIF_LAB_PROVIDER_SECRET=test-list-secret\n');
  let executions = 0;
  const lab = await createLabServer({ dataDir: root, envFile, projectDir: process.cwd(), analyze: false, job: async (mode, id) => {
    if (mode === 'prepare') await prepareDraft(root, id); else executions++;
  } });
  t.after(lab.stop);
  lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
  const base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
  const provider = { kind: 'server', id: 'default', secret: 'test-list-secret' };
  const post = (url: string, data: unknown) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(url.startsWith('/api/tasks') ? { ...(data as object), provider } : data) });
  assert.equal((await post('/api/providers', { secret: 'wrong' })).status, 401);
  const listed = await (await post('/api/providers', { secret: 'test-list-secret' })).json();
  assert.deepEqual(listed, { providers: [{ id: 'default', host: 'example.invalid:443' }] });
  assert.equal(((await (await fetch(base + '/api/queue')).json()) as { limit: number }).limit, 2);
  assert.equal((await post('/api/queue', { limit: 120 })).status, 200);
  assert.equal((await post('/api/queue', { limit: 121 })).status, 400);
  assert.equal((await post('/api/queue', { limit: 3 })).status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'queue-settings.json'), 'utf8')).limit, 3);
  async function upload(kind: string, bytes: Buffer) {
    const r = await fetch(`${base}/api/assets?kind=${kind}&name=test`, { method: 'POST', body: new Uint8Array(bytes) });
    assert.equal(r.status, 201); return await r.json() as Asset;
  }
  const gif = await upload('gif', fixture(9, 7, [2, 3, 4, 5].map(color => ({ pixels: Array(63).fill(color), options: { delay: 10 } })), 0));
  assert.equal(gif.samplingOptions?.resolution.maxLongEdge, 9);
  assert.equal(gif.samplingOptions?.frames.max, 4);
  assert.equal(gif.samplingOptions?.fps.max, 10);
  const ref = await upload('reference', await sharp({ create: { width: 8, height: 8, channels: 4, background: 'yellow' } }).png().toBuffer());
  const created = await post('/api/tasks', { gifAsset: gif.id, referenceAssets: [ref.id], settings: { scale: 0.5, maxFps: 5 } });
  assert.equal(created.status, 202);
  const id = ((await created.json()) as Task).id;
  let task: Task = await readTask(root, id);
  for (let tries = 0; task.status === 'preparing' && tries < 150; tries++) {
    await new Promise(resolve => setTimeout(resolve, 20)); task = await readTask(root, id);
  }
  assert.equal(task.status, 'draft'); assert.equal(executions, 0);
  assert.equal((await fetch(`${base}/files/tasks/${id}/plans/batch-000/input-sheet.png`)).status, 200);
  assert.equal((await fetch(`${base}/files/tasks/${id}/.env`)).status, 400);
  const unauthenticated = await fetch(`${base}/api/tasks/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draftHash: task.draftHash }) });
  assert.equal(unauthenticated.status, 400); assert.equal(executions, 0);
  assert.equal((await post(`/api/tasks/${id}/submit`, { draftHash: '0'.repeat(64) })).status, 400);
  const submitted = await Promise.all([post(`/api/tasks/${id}/submit`, { draftHash: task.draftHash }), post(`/api/tasks/${id}/submit`, { draftHash: task.draftHash })]);
  assert.ok(submitted.some(r => r.status === 202)); assert.ok(submitted.every(r => [202, 409].includes(r.status)));
  assert.equal(executions, 1);
  assert.equal((await post(`/api/tasks/${id}/submit`, { draftHash: task.draftHash })).status, 202);
  assert.equal(executions, 1);
  const configText = await (await fetch(base + '/api/config')).text();
  const tasksText = await (await fetch(base + '/api/tasks')).text();
  assert.ok(!configText.includes('private-web-test-key') && !tasksText.includes('private-web-test-key'));
  assert.ok(!configText.includes('example.invalid') && !configText.includes('gpt-image'));
  lab.stop(); await once(lab.server, 'close');
  const restarted = await createLabServer({ dataDir: root, envFile, projectDir: process.cwd() });
  t.after(restarted.stop);
  assert.equal((await readTask(root, id)).status, 'interrupted');
});
