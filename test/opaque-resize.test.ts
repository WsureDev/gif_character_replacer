import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { GifReader } from 'omggif';
import { fixture } from './fixtures.js';
import { extract } from '../src/pipeline.js';
import { prepareAiPlan } from '../src/ai-plan.js';
import { makePreviews } from '../src/ai-run.js';
import { isOpaque } from '../src/pixels.js';
import { prepareSampledAnimation, resizeFinalAnimation } from '../src/sampling.js';

test('opaque crop at 1226x1076→341x300 stays opaque and encodable; actual partial alpha is rejected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-opaque-crop-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(`${root}/input.gif`, fixture(341, 300, [{ pixels: Array(341 * 300).fill(5), options: { delay: 38 } }], 3));
  await extract(`${root}/input.gif`, `${root}/source`);
  await sharp({ create: { width: 16, height: 16, channels: 3, background: 'yellow' } }).png().toFile(`${root}/reference.png`);
  const plan = await prepareAiPlan({ input: `${root}/source/animation.json`, reference: [`${root}/reference.png`], out: `${root}/plan`, frameCount: 1, size: '1280x1280', subject: 'mascot', characterNotes: 'yellow' });
  const derived = { ...plan, layout: { ...plan.layout, width: 1254, height: 1254, cells: [{ frameOffset: 0, x: 12, y: 87, width: 1230, height: 1080 }] } };
  const patch = await sharp({ create: { width: 1230, height: 1080, channels: 4, background: '#777777' } }).png().toBuffer();
  const sheet = await sharp({ create: { width: 1254, height: 1254, channels: 4, background: 'white' } }).composite([{ input: patch, left: 12, top: 87 }]).png().toBuffer();
  const inputs = new Map([[plan.frames[0]!.file, await fs.readFile(`${root}/plan/${plan.frames[0]!.file}`)]]);
  await fs.mkdir(`${root}/preview`); const result = await makePreviews(sheet, derived, `${root}/preview`, inputs);
  assert.equal(result.frames, 1); assert.equal(result.durationMs, 380);
  assert.ok(isOpaque(await sharp(`${root}/preview/frames/frame-0000.png`).ensureAlpha().raw().toBuffer()));
  const gif = new GifReader(await fs.readFile(`${root}/preview/edited-preview.gif`)); assert.equal(gif.width, 341); assert.equal(gif.height, 300);
  const rgba = await sharp(sheet).ensureAlpha().raw().toBuffer(); rgba[3] = 254;
  const partial = await sharp(rgba, { raw: { width: 1254, height: 1254, channels: 4 } }).png().toBuffer();
  await fs.mkdir(`${root}/rejected`); await assert.rejects(makePreviews(partial, derived, `${root}/rejected`, inputs), /requires alpha=255/);
});

test('sampling and final resizing preserve opaque pixels, frame delay and finite loop', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-opaque-final-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(`${root}/input.gif`, fixture(1226, 1076, [{ pixels: Array(1226 * 1076).fill(5), options: { delay: 38 } }], 3));
  await prepareSampledAnimation(`${root}/input.gif`, `${root}/sampled`, 341 / 1226, 0);
  assert.ok(isOpaque(await sharp(`${root}/sampled/frame-000000.png`).ensureAlpha().raw().toBuffer()));
  await extract(`${root}/input.gif`, `${root}/source`);
  await resizeFinalAnimation(`${root}/source/animation.json`, `${root}/final`, 341, 300);
  assert.ok(isOpaque(await sharp(`${root}/final/frame-000000.png`).ensureAlpha().raw().toBuffer()));
  const gif = new GifReader(await fs.readFile(`${root}/final/edited.gif`)); assert.equal(gif.frameInfo(0).delay, 38); assert.equal(gif.loopCount(), 3);
});
