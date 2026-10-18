import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { GifReader } from 'omggif';
import { assembleAiBatches } from '../src/ai-assemble.js';
import { prepareAiPlan } from '../src/ai-plan.js';
import { extract } from '../src/pipeline.js';
import { fixture } from './fixtures.js';

async function setup(root: string) {
  await fs.writeFile(path.join(root, 'source.gif'), fixture(7, 5,
    [0, 1, 7, 23].map(delay => ({ pixels: Array(35).fill(1), options: { delay } })), 3));
  await extract(path.join(root, 'source.gif'), path.join(root, 'source'));
  await sharp({ create: { width: 8, height: 8, channels: 4, background: 'yellow' } }).png().toFile(path.join(root, 'reference.png'));
  const colors = ['red', 'lime', 'blue', 'yellow'];
  const batches = [];
  for (const i of [0, 1]) {
    const dir = `batch${i}`;
    await prepareAiPlan({ input: path.join(root, 'source/animation.json'), reference: [path.join(root, 'reference.png')],
      out: path.join(root, dir), frameCount: 2, startFrame: i * 2, size: '1024x1024', columns: 2,
      subject: 'the mascot', characterNotes: 'yellow character' });
    await fs.mkdir(path.join(root, dir, 'edited'));
    for (const j of [0, 1]) await sharp({ create: { width: 7, height: 5, channels: 4, background: colors[i * 2 + j]! } })
      .png().toFile(path.join(root, dir, 'edited', `frame-000${j}.png`));
    batches.push({ id: dir, plan: `${dir}/plan.json`, frames: `${dir}/edited`, origin: i === 0 ? 'reused' : 'generated' });
  }
  const bundle = { version: 1, source: 'source/animation.json', batches };
  await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify(bundle));
  return bundle;
}

test('full AI assembly orders batches by source index and preserves edited pixels, delays and finite loop', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-assembly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = await setup(root);
  bundle.batches.reverse();
  await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify(bundle));
  const result = await assembleAiBatches(path.join(root, 'bundle.json'), path.join(root, 'result'));
  assert.equal(result.frameCount, 4);
  assert.equal(result.durationMs, 310);
  assert.equal(result.reusedBatches, 1);
  assert.equal(result.generatedBatches, 1);
  const reader = new GifReader(await fs.readFile(result.output));
  assert.equal(reader.numFrames(), 4);
  assert.equal(reader.loopCount(), 3);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => reader.frameInfo(i).delay), [0, 1, 7, 23]);
  const expected = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
  for (let i = 0; i < 4; i++) {
    const rgba = Buffer.alloc(7 * 5 * 4);
    reader.decodeAndBlitFrameRGBA(i, rgba);
    assert.deepEqual([...rgba.subarray(0, 4)], expected[i]);
  }
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'result/frame-provenance.json'), 'utf8'));
  assert.deepEqual(provenance.map((f: { batchId: string }) => f.batchId), ['batch0', 'batch0', 'batch1', 'batch1']);
  await assert.rejects(assembleAiBatches(path.join(root, 'bundle.json'), path.join(root, 'result')), /EEXIST/);
});

test('full AI assembly rejects missing, duplicated, mismatched and transparent batch frames before publishing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-assembly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = await setup(root);
  const planFile = path.join(root, 'batch1/plan.json');
  const savedPlan = await fs.readFile(planFile, 'utf8');
  for (const kind of ['missing', 'duplicate-frame', 'duplicate-id', 'source', 'reference', 'timing', 'alpha']) {
    const bundle = structuredClone(original);
    const plan = JSON.parse(savedPlan);
    let error: RegExp;
    switch (kind) {
      case 'missing': bundle.batches.pop(); error = /Missing edited frames: 2, 3/; break;
      case 'duplicate-frame': bundle.batches[1]!.plan = bundle.batches[0]!.plan; error = /Duplicate edited frame/; break;
      case 'duplicate-id': bundle.batches[1]!.id = bundle.batches[0]!.id; error = /Duplicate batch ID/; break;
      case 'source': plan.source.sha256 = 'f'.repeat(64); error = /different source animation/; break;
      case 'reference': plan.references[0].sha256 = 'f'.repeat(64); error = /different character references/; break;
      case 'timing': plan.frames[0].delayMs += 10; error = /source hash\/timing mismatch/; break;
      default:
        await sharp({ create: { width: 7, height: 5, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
          .png().toFile(path.join(root, 'batch1/edited/frame-0000.png'));
        error = /Unexpected transparency/;
    }
    await fs.writeFile(planFile, JSON.stringify(plan));
    await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify(bundle));
    const out = path.join(root, `rejected-${kind}`);
    await assert.rejects(assembleAiBatches(path.join(root, 'bundle.json'), out), error, kind);
    await assert.rejects(fs.stat(out), { code: 'ENOENT' });
  }
});
