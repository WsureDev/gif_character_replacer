import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { assemble, extract, pack, split, roundtrip, batch } from '../src/pipeline.js';
import { validateSheets } from '../src/manifests.js';
import { fixture } from './fixtures.js';

async function workspace(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-test-')); }

test('odd non-square frames survive multi-sheet packing, tail cells, gaps and no-AI GIF roundtrip', async t => {
  const root = await workspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = fixture(7, 3, Array.from({ length: 11 }, (_, i) => ({
    pixels: Array.from({ length: 21 }, (_, p) => (p + i) % 8), options: { delay: i, disposal: 1 },
  })), 4);
  const input = path.join(root, 'original.gif');
  await fs.writeFile(input, source);
  const report = await roundtrip(input, path.join(root, 'result'), { columns: 3, batchSize: 4, gutter: 5, margin: 7 });
  assert.equal(report.sheetCount, 3);
  assert.equal(report.frames, 11);
  assert.equal(report.durationMs, 550);
  assert.equal(report.loopCount, 4);
  assert.deepEqual(report.checks, { pngPixelExact: true, gifPixelExact: true, frameCount: true, delays: true, loop: true, alpha: true });
  assert.deepEqual(await fs.readFile(input), source);
  await assert.rejects(roundtrip(input, path.join(root, 'result')), /EEXIST/);
});

test('transparent and opaque displayed frames are packed into separate consecutive groups', async t => {
  const root = await workspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.gif'), fixture(2, 2, [
    { pixels: [0, 2, 0, 0], options: { delay: 2, disposal: 2, transparent: 0 } },
    { pixels: [1, 1, 1, 1], options: { delay: 3, disposal: 2, transparent: 0 } },
    { pixels: [0, 3, 0, 0], options: { delay: 4, disposal: 2, transparent: 0 } },
  ]));
  const report = await roundtrip(path.join(root, 'input.gif'), path.join(root, 'out'));
  assert.equal(report.sheetCount, 3);
  assert.deepEqual(report.sheets.map(s => s.background), ['transparent', 'opaque', 'transparent']);
  assert.equal(report.checks.pngPixelExact, true);
  assert.equal(report.checks.gifPixelExact, true);
});

test('split rejects model-sized output drift and accidental transparent white background', async t => {
  const root = await workspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.gif'), fixture(3, 2, [{ pixels: [1, 1, 2, 1, 1, 1], options: { delay: 2 } }]));
  await extract(path.join(root, 'input.gif'), path.join(root, 'frames'));
  const sheet = (await pack(path.join(root, 'frames/animation.json'), path.join(root, 'sheets'))).sheets[0]!;
  const wrongSize = path.join(root, 'wrong-size');
  await fs.mkdir(wrongSize);
  await sharp({ create: { width: sheet.width + 1, height: sheet.height, channels: 4, background: 'white' } }).png().toFile(path.join(wrongSize, sheet.file));
  await assert.rejects(split(path.join(root, 'sheets/sheets.json'), path.join(root, 'split-size'), wrongSize), /Expected one/);
  const transparent = path.join(root, 'transparent');
  await fs.mkdir(transparent);
  await sharp({ create: { width: sheet.width, height: sheet.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toFile(path.join(transparent, sheet.file));
  await assert.rejects(split(path.join(root, 'sheets/sheets.json'), path.join(root, 'split-alpha'), transparent), /unexpected transparency/);
});

test('manifests reject missing, repeated, overlapping and out-of-bounds cells', async t => {
  const root = await workspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'in.gif'), fixture(3, 2, [1, 2, 3].map(color => ({ pixels: Array(6).fill(color), options: { delay: 2 } }))));
  await extract(path.join(root, 'in.gif'), path.join(root, 'frames'));
  const manifest = await pack(path.join(root, 'frames/animation.json'), path.join(root, 'sheets'));
  const missing = structuredClone(manifest);
  missing.sheets[0]!.cells.pop();
  assert.throws(() => validateSheets(missing), /cover every frame/);
  const repeated = structuredClone(manifest);
  repeated.sheets[0]!.cells[1]!.frameIndex = 0;
  assert.throws(() => validateSheets(repeated), /duplicated/);
  const overlap = structuredClone(manifest);
  overlap.sheets[0]!.cells[1]!.x = overlap.sheets[0]!.cells[0]!.x;
  assert.throws(() => validateSheets(overlap), /overlap/);
  const outside = structuredClone(manifest);
  outside.sheets[0]!.cells[0]!.x = 10000;
  assert.throws(() => validateSheets(outside), /geometry/);
});

test('assembly rejects a changed PNG whose manifest still claims original pixels', async t => {
  const root = await workspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'in.gif'), fixture(2, 2, [{ pixels: [1, 2, 3, 4], options: { delay: 4 } }]));
  await extract(path.join(root, 'in.gif'), path.join(root, 'frames'));
  await sharp({ create: { width: 2, height: 2, channels: 4, background: 'white' } }).png().toFile(path.join(root, 'frames/frame-000000.png'));
  await assert.rejects(assemble(path.join(root, 'frames/animation.json'), path.join(root, 'out.gif')), /do not match/);
});

test('batch records individual failures and keeps the successful cases reviewable', async t => {
  const root = await workspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputs = path.join(root, 'inputs');
  await fs.mkdir(inputs);
  await fs.writeFile(path.join(inputs, 'good.gif'), fixture(2, 2, [{ pixels: [1, 2, 3, 4], options: { delay: 4 } }]));
  await fs.writeFile(path.join(inputs, 'bad.gif'), 'not a gif');
  const report = await batch(inputs, path.join(root, 'out'));
  assert.deepEqual(report.results.map(r => r.status), ['failed', 'completed']);
  const html = await fs.readFile(path.join(root, 'out/index.html'), 'utf8');
  assert.match(html, /bad.gif/);
  assert.match(html, /case-02\/roundtrip.gif/);
});
