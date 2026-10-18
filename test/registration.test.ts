import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fixture } from './fixtures.js';
import { extract } from '../src/pipeline.js';
import { prepareAiPlan } from '../src/ai-plan.js';
import { markerPositions } from '../src/fiducials.js';
import { recoverImageEdit, recoverLayout } from '../src/ai-recover.js';
import { cleanCrop, edgeWhiteFraction } from '../src/crop-cleanup.js';
import { validateEditedSheet } from '../src/ai-run.js';

test('dense downscaled sheets survive provider palette drift and chroma mixing without accepting missing tags', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-marker-palette-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.gif'), fixture(32, 32, Array.from({ length: 25 }, () => ({ pixels: Array(1024).fill(5), options: { delay: 7 } })), 0));
  await extract(path.join(root, 'input.gif'), path.join(root, 'source'));
  await sharp({ create: { width: 16, height: 16, channels: 3, background: 'yellow' } }).png().toFile(path.join(root, 'ref.png'));
  const plan = await prepareAiPlan({ input: path.join(root, 'source/animation.json'), reference: [path.join(root, 'ref.png')],
    out: path.join(root, 'plan'), size: '2096x2096', frameCount: 25, columns: 5, registrationMarkers: true,
    subject: 'mascot', characterNotes: 'yellow' });
  const colors = ['#ff00f0', '#009fff', '#00be78', '#f00046'];
  const patches = await Promise.all(colors.map(background => sharp({ create: { width: 5, height: 5, channels: 3, background } }).png().toBuffer()));
  const redrawn = await sharp(path.join(root, 'plan/input-sheet.png')).composite(markerPositions(plan.layout).map(m => ({ input: patches[m.color]!, left: m.x, top: m.y }))).png().toBuffer();
  const resized = await sharp(redrawn).resize(1254, 1254).jpeg({ quality: 88, chromaSubsampling: '4:2:0' }).toBuffer();
  const returned = await sharp(resized).png().toBuffer();
  const result = await recoverLayout(returned, plan);
  assert.equal(result.registration.method, 'four-corner-hue-components-v2');
  assert.equal(result.registration.matches?.length, 100);
  assert.equal(result.registration.validation.passed, true);
  for (const [i, c] of result.derived.layout.cells.entries()) {
    const original = plan.layout.cells[i]!;
    assert.ok(Math.abs(c.x - original.x * 1254 / 2096) <= 2);
    assert.ok(Math.abs(c.y - original.y * 1254 / 2096) <= 2);
  }
  const first = markerPositions(plan.layout)[0]!;
  const erasedSource = await sharp(redrawn).composite([{ input: await sharp({ create: { width: 7, height: 7, channels: 3, background: 'white' } }).png().toBuffer(), left: first.x - 1, top: first.y - 1 }]).png().toBuffer();
  const erased = await sharp(erasedSource).resize(1254, 1254).png().toBuffer();
  await assert.rejects(recoverLayout(erased, plan), /缺失 TL/);
});

test('inward marker rounding is excluded from padding statistics without accepting transparent pixels or dirty gutters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-edge-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.gif'), fixture(10, 10, Array.from({ length: 16 }, () => ({ pixels: Array(100).fill(5), options: { delay: 7 } })), 0));
  await extract(path.join(root, 'input.gif'), path.join(root, 'source'));
  await sharp({ create: { width: 10, height: 10, channels: 4, background: 'yellow' } }).png().toFile(path.join(root, 'ref.png'));
  const plan = await prepareAiPlan({ input: path.join(root, 'source/animation.json'), reference: [path.join(root, 'ref.png')],
    out: path.join(root, 'plan'), size: '1280x1280', frameCount: 16, columns: 4, registrationMarkers: true, subject: 'the mascot', characterNotes: 'yellow' });
  const bytes = await fs.readFile(path.join(root, 'plan/input-sheet.png'));
  const inward = { ...plan, layout: { ...plan.layout, cells: plan.layout.cells.map(c => ({ ...c, x: c.x + 1, y: c.y + 1, width: c.width - 2, height: c.height - 2 })) } };
  assert.equal((await validateEditedSheet(bytes, inward)).passed, false);
  const corrected = await validateEditedSheet(bytes, inward, 2);
  assert.equal(corrected.passed, true); assert.equal(corrected.changedGutterFraction, 0);
  const rgba = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const transparent = Buffer.from(rgba), cell = inward.layout.cells[0]!;
  transparent[((cell.y * 1280 + cell.x - 1) * 4) + 3] = 0;
  const transparentPng = await sharp(transparent, { raw: { width: 1280, height: 1280, channels: 4 } }).png().toBuffer();
  assert.equal((await validateEditedSheet(transparentPng, inward, 2)).passed, false);
  for (const c of plan.layout.cells.slice(0, 3)) for (let y = 0; y < 1280; y++) for (let x = c.x + c.width + 6; x < c.x + c.width + 12; x++) {
    const p = (y * 1280 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 110;
  }
  const dirty = await sharp(rgba, { raw: { width: 1280, height: 1280, channels: 4 } }).png().toBuffer();
  assert.equal((await validateEditedSheet(dirty, inward, 2)).passed, false);
});

test('four-corner registration handles resized output, excludes tags and fills the target without gutters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-markers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.gif'), fixture(32, 23, [2, 3, 4, 5, 6, 2].map(c => ({ pixels: Array(32 * 23).fill(c), options: { delay: 7 } })), 0));
  await extract(path.join(root, 'input.gif'), path.join(root, 'source'));
  await sharp({ create: { width: 20, height: 20, channels: 3, background: 'yellow' } }).png().toFile(path.join(root, 'ref.png'));
  const plan = await prepareAiPlan({ input: path.join(root, 'source/animation.json'), reference: [path.join(root, 'ref.png')],
    out: path.join(root, 'plan'), size: '1280x1280', frameCount: 6, columns: 3, gutter: 8, margin: 12,
    registrationMarkers: true, subject: 'the mascot', characterNotes: 'yellow' });
  assert.equal(plan.layout.gutter, 16); assert.ok(plan.fiducials);
  const original = await fs.readFile(path.join(root, 'plan/input-sheet.png'));
  const returned = await sharp(original).resize(1254, 1210, { fit: 'fill' }).png().toBuffer();
  await fs.writeFile(path.join(root, 'returned.png'), returned);
  const registration = await recoverLayout(returned, plan);
  assert.equal(registration.registration.method, 'four-corner-color-components-v1');
  assert.equal(registration.registration.matches?.length, 24);
  await recoverImageEdit(path.join(root, 'plan/plan.json'), path.join(root, 'returned.png'), path.join(root, 'recovered'));
  for (let i = 0; i < 6; i++) {
    const { data, info } = await sharp(path.join(root, 'recovered/frames', `frame-000${i}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 32); assert.equal(info.height, 23);
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) assert.equal(edgeWhiteFraction(data, 32, { x: 0, y: 0, width: 32, height: 23 }, edge), 0);
  }
  const marker = markerPositions(plan.layout)[0]!;
  const blank = await sharp({ create: { width: 7, height: 7, channels: 3, background: 'white' } }).png().toBuffer();
  const erased = await sharp(original).composite([{ input: blank, left: marker.x - 1, top: marker.y - 1 }]).png().toBuffer();
  await assert.rejects(recoverLayout(erased, plan), /缺失 TL/);
});

test('crop cleanup removes added white edges but retains a genuinely white opaque scene', async () => {
  const source = await sharp({ create: { width: 30, height: 20, channels: 4, background: '#303030' } }).raw().toBuffer();
  const patch = await sharp({ create: { width: 100, height: 70, channels: 4, background: '#303030' } }).png().toBuffer();
  const sheet = await sharp({ create: { width: 110, height: 80, channels: 4, background: 'white' } }).composite([{ input: patch, left: 5, top: 5 }]).raw().toBuffer();
  const cleaned = cleanCrop(sheet, 110, { x: 3, y: 3, width: 104, height: 74 }, source, 30, 20);
  assert.equal(cleaned.fit, 'fill'); assert.ok(cleaned.crop.x >= 5 && cleaned.crop.y >= 5);
  assert.ok(Object.values(cleaned.remainingWhite).every(n => n === 0));
  const white = Buffer.alloc(30 * 20 * 4, 255);
  const kept = cleanCrop(white, 30, { x: 0, y: 0, width: 30, height: 20 }, white, 30, 20);
  assert.ok(Object.values(kept.trims).every(n => n === 0));
  assert.ok(Object.values(kept.remainingWhite).every(n => n === 1));
});
