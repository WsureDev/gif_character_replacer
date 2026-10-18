import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { planAdaptiveBatches, prepareAdaptivePlans } from '../src/adaptive-layout.js';
import { extract } from '../src/pipeline.js';
import { readAiPlan, replacementPrompt } from '../src/ai-plan.js';
import { fixture } from './fixtures.js';

const fixed = { output: { minWidth: 1280, maxWidth: 1280, minHeight: 1280, maxHeight: 1280 } };

test('same output canvas gives small frames more capacity and large frames less', () => {
  assert.equal(planAdaptiveBatches(235, 235, 100, fixed).maxFramesInThisPlan, 25);
  assert.equal(planAdaptiveBatches(400, 400, 100, fixed).maxFramesInThisPlan, 9);
  assert.equal(planAdaptiveBatches(800, 800, 100, fixed).maxFramesInThisPlan, 1);
  assert.equal(planAdaptiveBatches(800, 800, 100, { ...fixed, minScale: 0.5 }).maxFramesInThisPlan, 9);
});

test('all source frames are covered once and a tail batch is planned separately', () => {
  const result = planAdaptiveBatches(235, 235, 67, fixed);
  assert.deepEqual(result.sheets.map(s => s.frameCount), [25, 25, 17]);
  const indices = result.sheets.flatMap(s => Array.from({ length: s.frameCount }, (_, i) => s.startFrame + i));
  assert.deepEqual(indices, Array.from({ length: 67 }, (_, i) => i));
  assert.equal(result.totalCostInImagePriceUnits, 3);
  assert.ok(result.sheets.every(s => s.layout.scale >= 1));
});

test('output range and optional caps are honored without an implicit 5x5 or 64-frame ceiling', () => {
  const range = { output: { minWidth: 1024, maxWidth: 1536, minHeight: 1024, maxHeight: 1536 } };
  const result = planAdaptiveBatches(235, 235, 40, range);
  assert.deepEqual(result.sheets.map(s => s.frameCount), [36, 4]);
  assert.ok(result.sheets[1]!.layout.width * result.sheets[1]!.layout.height < result.sheets[0]!.layout.width * result.sheets[0]!.layout.height);
  const dense = planAdaptiveBatches(128, 128, 100, fixed);
  assert.equal(dense.maxFramesInThisPlan, 81);
  assert.deepEqual(dense.sheets.map(s => s.frameCount), [81, 19]);
  assert.ok(replacementPrompt(dense.sheets[0]!.layout, 'the mascot', 'yellow character').length < 32000);
  assert.equal(planAdaptiveBatches(128, 128, 100, { ...fixed, maxFramesPerSheet: 25 }).maxFramesInThisPlan, 25);
});

test('impossible bounds fail instead of secretly shrinking frames', () => {
  assert.throws(() => planAdaptiveBatches(2000, 2000, 10, fixed), /No frame fits/);
  assert.throws(() => planAdaptiveBatches(235, 235, 10, { output: { minWidth: 1536, maxWidth: 1024, minHeight: 1024, maxHeight: 1536 } }), /Invalid/);
  assert.throws(() => planAdaptiveBatches(235, 235, 10, { ...fixed, minScale: 0 }), /Invalid/);
});

test('adaptive preparation emits ready-to-edit plans for every frame without network calls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-adaptive-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.gif');
  await fs.writeFile(input, fixture(7, 5, [1, 2, 3, 4].map(color => ({ pixels: Array(35).fill(color), options: { delay: color } })), 0));
  await extract(input, path.join(root, 'frames'));
  await sharp({ create: { width: 10, height: 10, channels: 3, background: 'yellow' } }).png().toFile(path.join(root, 'reference.png'));
  const result = await prepareAdaptivePlans({ ...fixed, maxFramesPerSheet: 3, input: path.join(root, 'frames/animation.json'),
    reference: [path.join(root, 'reference.png')], out: path.join(root, 'plans'), subject: 'the mascot', characterNotes: 'yellow character' });
  assert.equal(result.outputImageCount, 2);
  const frames = [];
  for (const batch of result.plans) {
    const plan = await readAiPlan(path.join(root, 'plans', batch.directory, 'plan.json'));
    frames.push(...plan.frames.map(f => f.sourceIndex));
  }
  assert.deepEqual(frames, [0, 1, 2, 3]);
});
