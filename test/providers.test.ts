import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { listProviders, resolveProvider, ProviderAccessError } from '../src/providers.js';
import { createLabServer } from '../src/web-server.js';
import { prepareDraft } from '../src/lab-jobs.js';
import { readTask } from '../src/lab-store.js';
import { fixture } from './fixtures.js';
import type { AiConfig } from '../src/ai-config.js';

test('server registry fails closed and exposes only IDs plus domain:port; custom credentials do not require server secret', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-provider-registry-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = `${root}/test.env`;
  await fs.writeFile(file, `OPENAI_BASE_URL=https://provider.test/private/v1\nOPENAI_API_KEY=server-private-key\nOPENAI_IMAGE_MODEL=private-model\n`);
  await assert.rejects(listProviders(file, ''), (e: unknown) => e instanceof ProviderAccessError && e.status === 503);
  const list = [{ id: 'first', envPrefix: 'OPENAI' }, { id: 'second', baseUrl: 'http://backup.test:9188/custom/v1', apiKey: 'second-private-key', model: 'second-model' }];
  await fs.appendFile(file, `GIF_LAB_PROVIDER_SECRET=private-list-secret\nGIF_LAB_PROVIDERS='${JSON.stringify(list)}'\n`);
  await assert.rejects(listProviders(file, 'wrong'), (e: unknown) => e instanceof ProviderAccessError && e.status === 401);
  assert.deepEqual(await listProviders(file, 'private-list-secret'), [{ id: 'first', host: 'provider.test:443' }, { id: 'second', host: 'backup.test:9188' }]);
  await assert.rejects(resolveProvider(file, { kind: 'server', id: 'first', secret: 'wrong' }));
  assert.equal((await resolveProvider(file, { kind: 'server', id: 'second', secret: 'private-list-secret' }))?.OPENAI_API_KEY, 'second-private-key');
  const custom = await resolveProvider(file, { kind: 'browser', config: { baseUrl: 'https://mine.test/v1', apiKey: 'my-key', model: 'my-model' } });
  assert.equal(custom?.PROVIDER_SOURCE, 'browser'); assert.equal(custom?.OPENAI_BASE_URL, 'https://mine.test/v1');
  assert.equal(await resolveProvider(file, undefined, false), undefined);
  await assert.rejects(resolveProvider(file, undefined));
  await assert.rejects(resolveProvider(file, { kind: 'browser', config: { baseUrl: 'https://user:secret@mine.test/v1', apiKey: 'my-key', model: 'my-model' } }), /地址或参数/);
  await fs.appendFile(file, 'GIF_LAB_PROVIDERS=not-json-containing-server-private-key\n');
  await assert.rejects(listProviders(file, 'private-list-secret'), (e: unknown) => e instanceof Error && !e.message.includes('server-private-key'));
});

test('each web execution receives its selected provider in memory without persisting custom credentials or falling back to env', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-provider-jobs-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = `${root}/test.env`; await fs.writeFile(file, 'OPENAI_BASE_URL=https://env.test/v1\nOPENAI_API_KEY=env-secret\nOPENAI_IMAGE_MODEL=env-model\nGIF_LAB_PROVIDER_SECRET=registry-secret\n');
  const executions: AiConfig[] = [];
  const lab = await createLabServer({ dataDir: root, envFile: file, projectDir: process.cwd(), analyze: false, job: async (mode, id, _gate, config) => {
    if (mode === 'prepare') await prepareDraft(root, id); else { assert.ok(config); executions.push(config); }
  } }); t.after(lab.stop); lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
  const base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const upload = async (kind: string, bytes: Buffer) => (await (await fetch(`${base}/api/assets?kind=${kind}&name=fixture`, { method: 'POST', body: new Uint8Array(bytes) })).json()) as { id: string };
  const gif = await upload('gif', fixture(10, 10, [2, 3].map(c => ({ pixels: Array(100).fill(c), options: { delay: 7 } })), 0));
  const ref = await upload('reference', await sharp({ create: { width: 10, height: 10, channels: 3, background: 'yellow' } }).png().toBuffer());
  const tasks = [];
  for (const label of ['alpha', 'beta']) {
    const provider = { kind: 'browser', config: { baseUrl: `https://${label}.test/v1`, apiKey: `${label}-secret`, model: `${label}-model` } };
    const response = await post('/api/tasks', { gifAsset: gif.id, referenceAssets: [ref.id], settings: {}, provider }); assert.equal(response.status, 202);
    const { id } = await response.json() as { id: string };
    let task = await readTask(root, id); for (let i = 0; task.status === 'preparing' && i < 150; i++) { await new Promise(r => setTimeout(r, 20)); task = await readTask(root, id); }
    assert.equal(task.status, 'draft');
    assert.equal((await post(`/api/tasks/${id}/submit`, { draftHash: task.draftHash, provider: { kind: 'server', id: 'default', secret: 'wrong' } })).status, 401);
    assert.equal((await post(`/api/tasks/${id}/submit`, { draftHash: task.draftHash, provider })).status, 202); tasks.push(id);
  }
  assert.deepEqual(executions.map(c => c.OPENAI_BASE_URL), ['https://alpha.test/v1', 'https://beta.test/v1']);
  for (const id of tasks) { const text = await fs.readFile(`${root}/tasks/${id}/task.json`, 'utf8'); for (const hidden of ['alpha-secret', 'beta-secret', 'env-secret', 'registry-secret', 'https://alpha.test']) assert.ok(!text.includes(hidden)); }
});
