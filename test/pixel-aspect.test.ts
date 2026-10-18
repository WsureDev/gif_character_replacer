import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fixture } from './fixtures.js';
import { decodeGif } from '../src/gif.js';
import { prepareSampledAnimation } from '../src/sampling.js';
import { samplingOptions } from '../src/sampling-options.js';
import { squarePixelSize } from '../src/pixel-aspect.js';
import { prepareAiPlan } from '../src/ai-plan.js';
import { extract } from '../src/pipeline.js';

test('explicit square metadata and true non-square pixel displays produce correct sampling bounds and opaque previews', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-pixel-aspect-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [aspect, width, height] of [[0, 20, 10], [49, 20, 10], [113, 40, 10], [17, 20, 20]]) {
    const source = fixture(20, 10, [0, 3, 7].map(delay => ({ pixels: Array(200).fill(2), options: { delay } })), 3); source[12] = aspect!;
    const decoded = await decodeGif(source), options = samplingOptions(decoded.metadata);
    assert.equal(options.resolution.presets[0]!.width, width); assert.equal(options.resolution.presets[0]!.height, height);
    await fs.writeFile(`${root}/${aspect}.gif`, source);
    const summary = await prepareSampledAnimation(`${root}/${aspect}.gif`, `${root}/sampled-${aspect}`, 1, 0);
    assert.equal(summary.sampled.width, width); assert.equal(summary.sampled.height, height);
    const preview = await decodeGif(await fs.readFile(`${root}/sampled-${aspect}/preview.gif`));
    assert.equal(preview.metadata.pixelAspectRatio, 0); assert.equal(preview.metadata.loopCount, 3);
    assert.deepEqual(preview.metadata.frames.map(f => f.delayMs), [0, 30, 70]);
    if (aspect === 0 || aspect === 49) assert.deepEqual(preview.frames, decoded.frames);
  }
  assert.equal(squarePixelSize(240, 240, 49).corrected, false);
  assert.throws(() => squarePixelSize(20, 10, -1), /aspect/);
});

test('direct AI plans accept GIF aspect 49 as square pixels', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-square-tag-plan-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = fixture(20, 10, [{ pixels: Array(200).fill(2), options: { delay: 7 } }]); bytes[12] = 49;
  await fs.writeFile(`${root}/input.gif`, bytes); await extract(`${root}/input.gif`, `${root}/frames`);
  await sharp({ create: { width: 10, height: 10, channels: 3, background: 'yellow' } }).png().toFile(`${root}/ref.png`);
  const plan = await prepareAiPlan({ input: `${root}/frames/animation.json`, reference: [`${root}/ref.png`], out: `${root}/plan`, frameCount: 1, size: '1280x1280', subject: 'main character', characterNotes: '' });
  assert.equal(plan.source.width, 20); assert.equal(plan.source.height, 10);
});
