import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fixture } from './fixtures.js';
import { createTask, providerIdentity, readTask, taskDir } from '../src/lab-store.js';
import { approveDraft, approveTaskAction, executeTask, prepareDraft } from '../src/lab-jobs.js';
import { approveAnchorAction, trialImage } from '../src/anchor.js';
import { describeTask } from '../src/batch-state.js';
import { readAiPlan } from '../src/ai-plan.js';
import { readAnimation } from '../src/manifests.js';
import { runImageEdit } from '../src/ai-run.js';
import { imageClient, type AiConfig } from '../src/ai-config.js';
import { sha256 } from '../src/pixels.js';

const config: AiConfig = { OPENAI_BASE_URL: 'https://example.invalid/v1', OPENAI_API_KEY: 'not-a-real-key', OPENAI_IMAGE_MODEL: 'test', OPENAI_IMAGE_QUALITY: 'medium', OPENAI_IMAGE_TIMEOUT_MS: 1000 };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-anchor-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gif = randomUUID(), ref = randomUUID();
  for (const [id, kind] of [[gif, 'gif'], [ref, 'reference']] as const) {
    const dir = `${root}/assets/${id}`, file = kind === 'gif' ? 'source.gif' : 'reference.png'; await fs.mkdir(dir, { recursive: true });
    const bytes = kind === 'gif' ? fixture(20, 16, [2, 4, 3, 2, 4, 3].map((c, i) => ({ pixels: Array(320).fill(c), options: { delay: i } })), 3)
      : await sharp({ create: { width: 20, height: 16, channels: 4, background: 'yellow' } }).png().toBuffer();
    await fs.writeFile(`${dir}/${file}`, bytes); await fs.writeFile(`${dir}/asset.json`, JSON.stringify({ id, kind, file, name: kind, width: 20, height: 16, bytes: bytes.length }));
  }
  const parent = await createTask(root, { gifAsset: gif, referenceAssets: [ref], settings: { anchorMode: 'frame', dedupMode: 'exact', maxFramesPerSheet: 2 } }, providerIdentity(config));
  await prepareDraft(root, parent.id); return { root, parent: await readTask(root, parent.id) };
}

test('single-frame trial requires effect confirmation and a separate Submit; guided batches share a frozen reference and restore it after dedup', async t => {
  const { root, parent } = await setup(t);
  await assert.rejects(approveDraft(root, parent.id, parent.draftHash!, config), /先选帧/);
  const trialAction = { kind: 'trial', frameIndex: 4, operationId: randomUUID(), draftHash: parent.draftHash };
  const trial = (await approveAnchorAction(root, parent.id, trialAction, config)).task;
  assert.equal((await approveAnchorAction(root, parent.id, trialAction, config)).task.id, trial.id);
  await assert.rejects(approveAnchorAction(root, parent.id, { ...trialAction, operationId: randomUUID() }, config), /等待/);
  const draft = await prepareDraft(root, trial.id);
  assert.equal(draft.sheets?.length, 1); assert.equal(draft.sampling?.mapping[0]?.sourceIndex, 4); assert.equal(draft.sampling?.sampled.frames, 1);
  let calls = 0;
  const edit: typeof runImageEdit = async (p, out, cfg) => {
    const plan = await readAiPlan(p);
    return runImageEdit(p, out, cfg, imageClient(cfg, async (url, init) => {
      if (String(url).startsWith('data:')) return new Response('');
      calls++;
      const input = (init!.body as FormData).getAll('image[]')[0] as File;
      let png = Buffer.from(await input.arrayBuffer());
      if (calls === 1) { const c = plan.layout.cells[0]!;
        const patch = await sharp({ create: { width: c.width, height: c.height, channels: 4, background: '#c08040' } }).png().toBuffer();
        png = await sharp(png).composite([{ input: patch, left: c.x, top: c.y }]).png().toBuffer();
      }
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
    }));
  };
  await approveDraft(root, trial.id, draft.draftHash!, config); const doneTrial = await executeTask(root, trial.id, config, edit);
  assert.equal(calls, 1); assert.equal((await readTask(root, parent.id)).status, 'draft');
  const image = (await trialImage(root, doneTrial))!;
  const approval = { kind: 'approve', trialId: trial.id, imageSha256: image.sha256, operationId: randomUUID(), draftHash: parent.draftHash };
  await assert.rejects(approveAnchorAction(root, parent.id, { ...approval, imageSha256: '0'.repeat(64) }, config), /效果已变化/);
  const guided = (await approveAnchorAction(root, parent.id, approval, config)).task;
  assert.equal((await approveAnchorAction(root, parent.id, approval, config)).task.id, guided.id);
  const guidedDraft = await prepareDraft(root, guided.id);
  assert.equal(calls, 1); assert.equal(guidedDraft.status, 'draft'); assert.equal(guidedDraft.sheets?.length, 2);
  await assert.rejects(executeTask(root, guided.id, config, edit), /尚未提交/);
  const hashes = [];
  for (const sheet of guidedDraft.sheets!) {
    const plan = await readAiPlan(`${taskDir(root, guided.id)}/plans/${sheet.directory}/plan.json`);
    assert.equal(plan.references.length, 2); hashes.push(plan.references.at(-1)!.sha256);
    assert.match(await fs.readFile(`${taskDir(root, guided.id)}/plans/${sheet.directory}/prompt.txt`, 'utf8'), /IMAGE 3 is the APPROVED EDITED FRAME/);
  }
  assert.equal(new Set(hashes).size, 1);
  await approveDraft(root, guided.id, guidedDraft.draftHash!, config); const done = await executeTask(root, guided.id, config, edit);
  assert.equal(calls, 3); assert.equal(done.result?.frames, 6); assert.equal(done.result?.durationMs, 150);
  const animation = await readAnimation(`${taskDir(root, guided.id)}/${path.dirname(done.result!.file)}/animation.json`);
  const approvedHash = sha256(await sharp(image.bytes).ensureAlpha().raw().toBuffer());
  assert.equal(animation.loopCount, 3); assert.deepEqual(animation.frames.map(f => f.delayMs), [0, 10, 20, 30, 40, 50]);
  assert.equal(animation.frames[1]!.rgbaSha256, approvedHash); assert.equal(animation.frames[4]!.rgbaSha256, approvedHash);
  await approveTaskAction(root, guided.id, { operationId: randomUUID(), draftHash: guidedDraft.draftHash, kind: 'batch', sheetIndex: 0, mode: 'generate' }, config);
  const retried = await executeTask(root, guided.id, config, edit);
  assert.equal(calls, 4); assert.equal(retried.resultHistory?.length, 1);
  const updated = await readAnimation(`${taskDir(root, guided.id)}/${path.dirname(retried.result!.file)}/animation.json`);
  assert.equal(updated.frames[4]!.rgbaSha256, approvedHash);
  const described = await describeTask(root, await readTask(root, parent.id)); assert.equal(described.anchorPreviews[0]!.imageSha256, image.sha256);
});

test('anchor trial rejects stale input, invalid selection, provider drift and exhausted reference slots', async t => {
  const { root, parent } = await setup(t), action = { kind: 'trial', frameIndex: 6, draftHash: parent.draftHash, operationId: randomUUID() };
  await assert.rejects(approveAnchorAction(root, parent.id, action, config), /超出/);
  await assert.rejects(approveAnchorAction(root, parent.id, { ...action, frameIndex: 0 }, { ...config, OPENAI_IMAGE_MODEL: 'changed' }), /接口配置/);
  await assert.rejects(createTask(root, { gifAsset: parent.gifAsset, referenceAssets: Array(15).fill(parent.referenceAssets[0]), settings: { anchorMode: 'frame' } }, providerIdentity(config)), /14 张/);
  await fs.appendFile(`${taskDir(root, parent.id)}/sampled/frame-000000.png`, 'changed');
  await assert.rejects(approveAnchorAction(root, parent.id, { ...action, frameIndex: 0 }, config), /输入已变化/);
});
