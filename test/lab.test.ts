import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { GifReader } from 'omggif';
import { fixture } from './fixtures.js';
import { imageClient, type AiConfig } from '../src/ai-config.js';
import { runImageEdit } from '../src/ai-run.js';
import { createTask, providerIdentity, readAsset, readTask, taskDir, type Asset } from '../src/lab-store.js';
import { approveDraft, approveTaskAction, executeTask, failTask, prepareDraft } from '../src/lab-jobs.js';
import { analyzeAsset } from '../src/motion-analysis.js';
import { ImageQueue } from '../src/image-queue.js';
import { describeTask } from '../src/batch-state.js';

const config: AiConfig = { OPENAI_BASE_URL: 'https://example.invalid/v1', OPENAI_API_KEY: 'lab-private-test-secret',
  OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst', OPENAI_IMAGE_QUALITY: 'medium', OPENAI_IMAGE_TIMEOUT_MS: 1000 };

test('dedup draft freezes mapping, edits only representatives and restores all timeline frames after generation and retry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-dedup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await setup(root);
  const task = await createTask(root, { gifAsset: base.gifAsset, referenceAssets: base.referenceAssets,
    settings: { frameCount: 10, scale: 0.5, outputSize: 'original', dedupMode: 'auto', maxFramesPerSheet: 2 } }, providerIdentity(config));
  const draft = await prepareDraft(root, task.id);
  assert.equal(draft.dedup?.uniqueFrames, 5); assert.equal(draft.dedup?.baselineSheets, 5); assert.equal(draft.sheets?.length, 3);
  const mapping = path.join(taskDir(root, task.id), 'sampled/dedup/mapping.json'), saved = await fs.readFile(mapping);
  await fs.appendFile(mapping, ' '); await assert.rejects(approveDraft(root, task.id, draft.draftHash!, config), /内容已变化/); await fs.writeFile(mapping, saved);
  await approveDraft(root, task.id, draft.draftHash!, config);
  let calls = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    if (String(url).startsWith('data:')) return new Response('');
    calls++; const image = (init!.body as FormData).getAll('image[]')[0] as File;
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(await image.arrayBuffer()).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  };
  const edit: typeof runImageEdit = (p, out, c) => runImageEdit(p, out, c, imageClient(c, fetchMock));
  const done = await executeTask(root, task.id, config, edit);
  assert.equal(done.result?.frames, 10); assert.equal(done.result?.durationMs, 500); assert.equal(done.result?.width, 20); assert.equal(calls, 3);
  const gif = new GifReader(await fs.readFile(path.join(taskDir(root, task.id), done.result!.file)));
  assert.equal(gif.numFrames(), 10); assert.equal(gif.loopCount(), 3);
  await approveTaskAction(root, task.id, { operationId: randomUUID(), draftHash: draft.draftHash!, kind: 'batch', sheetIndex: 0, mode: 'generate' }, config);
  const retried = await executeTask(root, task.id, config, edit);
  assert.equal(calls, 4); assert.equal(retried.result?.frames, 10); assert.equal(retried.resultHistory?.length, 1);
});
async function setup(root: string) {
  const gifId = randomUUID(), refId = randomUUID();
  for (const [id, kind] of [[gifId, 'gif'], [refId, 'reference']] as const) {
    const dir = path.join(root, 'assets', id); await fs.mkdir(dir, { recursive: true });
    const file = kind === 'gif' ? 'source.gif' : 'reference.png';
    const bytes = kind === 'gif' ? fixture(20, 16, Array.from({ length: 10 }, (_, i) => ({ pixels: Array(320).fill(i % 5 + 2), options: { delay: 5 } })), 3)
      : await sharp({ create: { width: 20, height: 16, channels: 4, background: 'yellow' } }).png().toBuffer();
    await fs.writeFile(path.join(dir, file), bytes);
    const asset: Asset = { id, kind, name: kind, file, width: 20, height: 16, bytes: bytes.length };
    await fs.writeFile(path.join(dir, 'asset.json'), JSON.stringify(asset));
  }
  return createTask(root, { name: 'sampling test', gifAsset: gifId, referenceAssets: [refId],
    settings: { scale: 0.5, maxFps: 8, maxFramesPerSheet: 2, outputSize: 'original' } }, providerIdentity(config));
}

test('draft stays offline, submits once, recovers returned canvas and assembles a retimed full GIF', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-lab-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const created = await setup(root), draft = await prepareDraft(root, created.id);
  assert.equal(draft.status, 'draft'); assert.equal(draft.sheets?.length, 2);
  assert.equal(draft.sampling?.sampled.frames, 4);
  assert.ok(!(await fs.readdir(taskDir(root, draft.id))).some(n => n.startsWith('edit-')));
  await assert.rejects(executeTask(root, draft.id, config), /尚未提交/);
  await assert.rejects(approveDraft(root, draft.id, '0'.repeat(64), config), /版本不一致/);
  await assert.rejects(approveDraft(root, draft.id, draft.draftHash!, { ...config, OPENAI_IMAGE_QUALITY: 'high' }), /配置已变化/);
  assert.equal((await approveDraft(root, draft.id, draft.draftHash!, config)).enqueued, true);
  assert.equal((await approveDraft(root, draft.id, draft.draftHash!, config)).enqueued, false);
  let calls = 0;
  const mock: typeof fetch = async (url, init) => {
    if (String(url).startsWith('data:')) return new Response('');
    calls++;
    const image = (init!.body as FormData).getAll('image[]')[0] as File;
    const png = await sharp(Buffer.from(await image.arrayBuffer())).resize(1254, 1254).png().toBuffer();
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }], size: '1254x1254' }), { headers: { 'content-type': 'application/json' } });
  };
  const done = await executeTask(root, draft.id, config, (plan, out, cfg) => runImageEdit(plan, out, cfg, imageClient(cfg, mock)));
  assert.equal(calls, 2); assert.equal(done.status, 'completed'); assert.equal(done.result?.width, 20); assert.equal(done.result?.height, 16);
  const reader = new GifReader(await fs.readFile(path.join(taskDir(root, draft.id), done.result!.file)));
  assert.equal(reader.numFrames(), 4); assert.equal(reader.loopCount(), 3);
  assert.equal(Array.from({ length: 4 }, (_, i) => reader.frameInfo(i).delay).reduce((n, d) => n + d, 0), 50);
  await assert.rejects(executeTask(root, draft.id, config), /尚未提交/);
  assert.ok(!JSON.stringify(await readTask(root, draft.id)).includes(config.OPENAI_API_KEY));
});

test('modified draft pixels fail approval; uncertain generation is stopped without retry or secret leakage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-lab-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const created = await setup(root), draft = await prepareDraft(root, created.id);
  const file = path.join(taskDir(root, draft.id), 'plans/batch-000/input-sheet.png');
  const saved = await fs.readFile(file); await fs.appendFile(file, 'changed');
  await assert.rejects(approveDraft(root, draft.id, draft.draftHash!, config), /内容已变化/);
  await fs.writeFile(file, saved);
  await approveDraft(root, draft.id, draft.draftHash!, config);
  let calls = 0;
  try { await executeTask(root, draft.id, config, async () => { calls++; throw new Error(`connection unknown ${config.OPENAI_API_KEY}`); }, new ImageQueue(1)); }
  catch (error) { await failTask(root, draft.id, error, config.OPENAI_API_KEY); }
  const failed = await readTask(root, draft.id);
  assert.equal(calls, 1); assert.equal(failed.status, 'failed'); assert.ok(!failed.error?.includes(config.OPENAI_API_KEY));
  await assert.rejects(approveDraft(root, draft.id, draft.draftHash!, config), /只有准备完成/);
});

test('manual local retry reuses a returned image without credentials; new generation retries are explicit and idempotent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-retries-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await setup(root);
  const task = await createTask(root, { gifAsset: base.gifAsset, referenceAssets: base.referenceAssets,
    settings: { frameCount: 2, scale: 0.5 } }, providerIdentity(config));
  const draft = await prepareDraft(root, task.id);
  await approveDraft(root, task.id, draft.draftHash!, config);
  let calls = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    if (String(url).startsWith('data:')) return new Response('');
    calls++; const png = (init!.body as FormData).getAll('image[]')[0] as File;
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(await png.arrayBuffer()).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  };
  const edit: typeof runImageEdit = (p, out, c) => runImageEdit(p, out, c, imageClient(c, fetchMock));
  try { await executeTask(root, task.id, config, edit, new ImageQueue(2), async () => { throw new Error('simulated local validation failure'); }); }
  catch (e) { await failTask(root, task.id, e); }
  const failed = await describeTask(root, await readTask(root, task.id));
  assert.equal(calls, 1); assert.equal(failed.sheets[0]!.canRecover, true);
  assert.equal(failed.sheets[0]!.failureStage, 'processing'); assert.ok(failed.sheets[0]!.outputFile);
  const local = { operationId: randomUUID(), draftHash: draft.draftHash!, kind: 'batch', sheetIndex: 0, mode: 'recover' };
  await approveTaskAction(root, task.id, local);
  await executeTask(root, task.id, undefined, async () => { throw new Error('Local retry must not invoke Image API'); });
  assert.equal((await readTask(root, task.id)).status, 'completed'); assert.equal(calls, 1);
  assert.equal((await approveTaskAction(root, task.id, local)).enqueued, false);
  const regenerate = { ...local, operationId: randomUUID(), mode: 'generate' };
  const nextProvider = { ...config, OPENAI_BASE_URL: 'https://second-provider.invalid/v1', OPENAI_IMAGE_MODEL: 'gpt-image-2.5-flare' };
  await approveTaskAction(root, task.id, regenerate, nextProvider);
  const done = await executeTask(root, task.id, nextProvider, edit);
  assert.equal(calls, 2); assert.equal(done.sheets![0]!.editDirectory, 'edit-0-v2');
  assert.equal(done.resultHistory?.length, 1); assert.equal(done.result?.file, 'final-v2/edited.gif');
  assert.equal(done.executionProvider?.signature, providerIdentity(nextProvider).signature);
  assert.equal(done.provider?.signature, providerIdentity(config).signature); assert.equal(done.draftHash, draft.draftHash);
  assert.equal((await approveTaskAction(root, task.id, regenerate, config)).enqueued, false);
  await fs.access(path.join(taskDir(root, task.id), 'edit-0/edited-sheet.png'));
});

test('continuation sends only unsubmitted batches and keeps completed processing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-continue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await setup(root), draft = await prepareDraft(root, task.id);
  await approveDraft(root, task.id, draft.draftHash!, config);
  let calls = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    if (String(url).startsWith('data:')) return new Response('');
    calls++; const image = (init!.body as FormData).getAll('image[]')[0] as File;
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(await image.arrayBuffer()).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  };
  // Seed exactly one returned image, representing an interrupted original submission.
  await runImageEdit(path.join(taskDir(root, task.id), 'plans/batch-000/plan.json'), path.join(taskDir(root, task.id), 'edit-0'), config, imageClient(config, fetchMock));
  await failTask(root, task.id, new Error('interrupted after one response'));
  const local = { operationId: randomUUID(), draftHash: draft.draftHash!, kind: 'batch', sheetIndex: 0, mode: 'recover' };
  await approveTaskAction(root, task.id, local);
  const waiting = await executeTask(root, task.id, undefined);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.progress.completed, 1); assert.equal(calls, 1);
  await approveTaskAction(root, task.id, { operationId: randomUUID(), draftHash: draft.draftHash!, kind: 'continue' }, config);
  const done = await executeTask(root, task.id, config, (p, out, c) => runImageEdit(p, out, c, imageClient(c, fetchMock)));
  assert.equal(done.status, 'completed'); assert.equal(calls, 2);
  assert.equal(done.sheets![0]!.processingAttempts, 1);
  assert.equal(done.result?.frames, 4); assert.equal(done.result?.durationMs, 500);
});

test('uploaded GIF bounds constrain new drafts and an explicit frame count reaches the actual sheets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-lab-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = await setup(root);
  const asset = await readAsset(root, original.gifAsset);
  assert.equal(asset.samplingOptions?.frames.max, 10);
  assert.equal(asset.samplingOptions?.fps.max, 20);
  const base = { gifAsset: original.gifAsset, referenceAssets: original.referenceAssets };
  for (const settings of [{ frameCount: 11 }, { maxFps: 21 }, { maxFps: 1 }, { scale: 0.01 }, { maxFramesPerSheet: 11 }, { frameCount: 4, maxFps: 8 }]) {
    await assert.rejects(createTask(root, { ...base, settings }, providerIdentity(config)));
  }
  const created = await createTask(root, { ...base, settings: { scale: 0.5, frameCount: 3 } }, providerIdentity(config));
  const draft = await prepareDraft(root, created.id);
  assert.equal(draft.sampling?.sampled.frames, 3);
  assert.equal(draft.sampling?.sampled.durationMs, 500);
  assert.equal(draft.sampling?.frameCount, 3);
  assert.equal(draft.sheets?.reduce((sum, s) => sum + s.frames, 0), 3);
});

test('smart drafts freeze the analyzed source indices and retain timing while adding corner markers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-smart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = await setup(root);
  await analyzeAsset(path.join(root, 'assets', original.gifAsset));
  const analysis = JSON.parse(await fs.readFile(path.join(root, 'assets', original.gifAsset, 'motion-analysis.json'), 'utf8'));
  const selected = analysis.presets[0];
  const task = await createTask(root, { gifAsset: original.gifAsset, referenceAssets: original.referenceAssets,
    settings: { smartPreset: selected.id, scale: 0.5 } }, providerIdentity(config));
  const draft = await prepareDraft(root, task.id);
  assert.deepEqual(draft.sampling?.mapping.map(f => f.sourceIndex), selected.indices);
  assert.equal(draft.sampling?.sampled.durationMs, 500);
  assert.ok(draft.sheets?.every(s => s.registrationMarkers && s.gutter! >= 16));
  await assert.rejects(createTask(root, { gifAsset: original.gifAsset, referenceAssets: original.referenceAssets,
    settings: { smartPreset: selected.id, frameCount: 4 } }, providerIdentity(config)), /不能同时/);
});
