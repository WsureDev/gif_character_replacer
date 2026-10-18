import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { GifReader } from 'omggif';
import { fixture } from './fixtures.js';
import { prepareSampledAnimation } from '../src/sampling.js';
import { prepareDedup, restoreDedup, dedupDifference } from '../src/frame-dedup.js';
import { readAnimation } from '../src/manifests.js';
import { sha256 } from '../src/pixels.js';

const options = { output: { minWidth: 1024, maxWidth: 1024, minHeight: 1024, maxHeight: 1024 }, maxFramesPerSheet: 2, gutter: 16, margin: 12 };
async function setup(t: { after(fn: () => Promise<void>): void }, indices: number[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-dedup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const colors = [0x646464, 0x656565, 0x666666, 0x676767, 0, 0xffffff, 0xff0000, 0x00ff00];
  await fs.writeFile(`${root}/input.gif`, fixture(32, 32, indices.map((index, i) => ({ pixels: Array(1024).fill(index), options: { delay: i } })), 3, colors));
  await prepareSampledAnimation(`${root}/input.gif`, `${root}/sampled`, 1, 0);
  return root;
}

test('global dedup reuses non-adjacent frames without transitive drift and recommends actual sheet savings', async t => {
  const root = await setup(t, [0, 1, 2, 3, 0]);
  const summary = await prepareDedup(`${root}/sampled/animation.json`, `${root}/dedup`, 99.5, options);
  const map = JSON.parse(await fs.readFile(`${root}/dedup/mapping.json`, 'utf8'));
  assert.deepEqual(map.representatives, [0, 2]); assert.deepEqual(map.mapping, [0, 0, 1, 1, 0]);
  assert.equal(summary.baselineSheets, 3); assert.equal(summary.sheets, 1);
  assert.equal(summary.exactReuses, 1); assert.ok(summary.maxError <= 0.005);
  assert.equal(summary.recommendedSimilarity, 99.5);
  const exact = await prepareDedup(`${root}/sampled/animation.json`, `${root}/exact`, 100, options);
  assert.equal(exact.uniqueFrames, 4); assert.equal(exact.maxError, 0);
});

test('local blocks and peak guard retain a tiny moving feature on a static background', () => {
  const a = Buffer.alloc(256 * 256 * 4, 255), b = Buffer.from(a);
  b[0] = 0; b[1] = 0; b[2] = 0;
  const difference = dedupDifference(a, b, 256, 256);
  assert.equal(difference.peak, 1); assert.ok(difference.error > 1 / (256 * 256));
});

test('restoration uses edited representatives, retains zero/variable delays and loops, and rejects invalid maps', async t => {
  const root = await setup(t, [0, 1, 2, 3, 0]);
  await prepareDedup(`${root}/sampled/animation.json`, `${root}/dedup`, 99.5, options);
  const edited = await readAnimation(`${root}/dedup/animation.json`);
  await fs.mkdir(`${root}/edited`);
  for (const f of edited.frames) {
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: f.index === 0 ? 'red' : 'blue' } }).png().toBuffer();
    await fs.writeFile(`${root}/edited/${f.file}`, png); f.rgbaSha256 = sha256(await sharp(png).ensureAlpha().raw().toBuffer());
  }
  await fs.writeFile(`${root}/edited/animation.json`, JSON.stringify(edited));
  const run = (out: string) => restoreDedup(`${root}/sampled/animation.json`, `${root}/dedup/animation.json`, `${root}/edited/animation.json`, `${root}/dedup/mapping.json`, out);
  const result = await run(`${root}/restored`);
  const gif = new GifReader(await fs.readFile(result.output));
  assert.equal(gif.numFrames(), 5); assert.equal(gif.loopCount(), 3);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => gif.frameInfo(i).delay), [0, 1, 2, 3, 4]);
  for (const [i, expected] of [[0, 255], [1, 255], [2, 0], [3, 0], [4, 255]]) {
    const pixels = Buffer.alloc(32 * 32 * 4); gif.decodeAndBlitFrameRGBA(i!, pixels); assert.equal(pixels[0], expected);
  }
  const map = JSON.parse(await fs.readFile(`${root}/dedup/mapping.json`, 'utf8'));
  map.mapping[4] = 999; await fs.writeFile(`${root}/dedup/mapping.json`, JSON.stringify(map));
  await assert.rejects(run(`${root}/invalid`), /Invalid dedup/);
  await assert.rejects(fs.access(`${root}/invalid`));
});
