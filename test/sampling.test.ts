import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GifReader } from 'omggif';
import { sampleTimeline, prepareSampledAnimation } from '../src/sampling.js';
import { readAnimation } from '../src/manifests.js';
import { fixture } from './fixtures.js';
import { samplingOptions } from '../src/sampling-options.js';
import { inspectGif } from '../src/gif.js';

test('source-derived resolution, frame and FPS choices change with each GIF and handle still/zero-time inputs', () => {
  function options(width: number, height: number, delays: number[]) {
    return samplingOptions(inspectGif(fixture(width, height, delays.map(delay => ({ pixels: Array(width * height).fill(2), options: { delay } })))));
  }
  const landscape = options(40, 20, Array(67).fill(7));
  const portrait = options(20, 40, Array(10).fill(3));
  assert.equal(landscape.frames.max, 67); assert.equal(portrait.frames.max, 10);
  assert.equal(landscape.fps.max, 1000 / 70); assert.equal(portrait.fps.max, 1000 / 30);
  for (const o of [landscape, portrait]) {
    assert.equal(o.resolution.presets[0]!.longEdge, 40);
    assert.equal(o.resolution.presets.at(-1)!.longEdge, 1);
    assert.equal(new Set(o.resolution.presets.map(r => `${r.width}x${r.height}`)).size, o.resolution.presets.length);
    assert.ok(o.frames.presets.every(n => n >= o.frames.min && n <= o.frames.max));
    assert.ok(o.fps.presets.every(f => f.value <= o.fps.max && f.value >= o.fps.min));
  }
  assert.deepEqual(landscape.resolution.presets.map(r => [r.width, r.height]), portrait.resolution.presets.map(r => [r.height, r.width]));
  const tiny = options(3, 2, [10]);
  assert.equal(tiny.resolution.maxLongEdge, 3); assert.equal(tiny.canReduceFrames, false);
  assert.ok(tiny.resolution.presets.every(r => r.width <= 3 && r.height <= 2));
  const zero = options(5, 5, [0, 0, 0]);
  assert.equal(zero.canReduceFrames, false); assert.deepEqual(zero.frames, { min: 3, max: 3, presets: [3] });
  assert.deepEqual(zero.fps, { min: 0, max: 0, presets: [] });
});

test('explicit frame count keeps exactly that many unique source frames and their original timeline boundaries', () => {
  const delays = [20, 20, 20, 140, 200, 100];
  for (let n = 1; n <= delays.length; n++) {
    const chosen = sampleTimeline(delays, 0, n);
    assert.equal(chosen.length, n);
    assert.equal(new Set(chosen.map(f => f.sourceIndex)).size, n);
    assert.equal(chosen.reduce((sum, f) => sum + f.delayMs, 0), 500);
    let time = 0;
    for (const f of chosen) {
      assert.equal(time, delays.slice(0, f.sourceIndex).reduce((a, b) => a + b, 0));
      time += f.delayMs;
    }
  }
  assert.deepEqual(sampleTimeline([0, 0], 0, 2), [{ sourceIndex: 0, delayMs: 0 }, { sourceIndex: 1, delayMs: 0 }]);
  assert.throws(() => sampleTimeline(delays, 0, 7), /范围/);
  assert.throws(() => sampleTimeline(delays, 5, 3), /不能同时/);
  assert.throws(() => sampleTimeline([0, 0], 0, 1), /全部为 0/);
});

test('FPS sampling respects variable source timing, centiseconds and total duration without duplicating slow frames', () => {
  const delays = [20, 20, 20, 140, 200, 100];
  const selected = sampleTimeline(delays, 10);
  assert.deepEqual(selected, [{ sourceIndex: 0, delayMs: 100 }, { sourceIndex: 3, delayMs: 100 },
    { sourceIndex: 4, delayMs: 200 }, { sourceIndex: 5, delayMs: 100 }]);
  assert.deepEqual(sampleTimeline([0, 10, 70, 0], 0), [0, 10, 70, 0].map((delayMs, sourceIndex) => ({ sourceIndex, delayMs })));
  assert.deepEqual(sampleTimeline([70, 70, 70], 60).map(f => f.delayMs), [70, 70, 70]);
  assert.throws(() => sampleTimeline([0, 0], 10), /全部为 0/);
  for (const fps of [1, 5, 8, 12, 24, 30, 60]) {
    const values = Array.from({ length: 137 }, (_, i) => (i % 7 + 1) * 10);
    const frames = sampleTimeline(values, fps), duration = values.reduce((a, b) => a + b, 0);
    assert.equal(frames.reduce((a, f) => a + f.delayMs, 0), duration);
    assert.ok(frames.every(f => f.delayMs % 10 === 0));
    assert.ok(frames.length <= values.length && frames.length * 1000 / duration <= fps);
    assert.ok(frames.every((f, i) => i === 0 || f.sourceIndex > frames[i - 1]!.sourceIndex));
  }
});

test('spatial and temporal sampling produces an opaque preview with unchanged duration and loop', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-sampling-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'input.gif');
  await fs.writeFile(file, fixture(15, 9, Array.from({ length: 10 }, (_, i) => ({ pixels: Array(135).fill(i % 6 + 1), options: { delay: 5 } })), 4));
  const summary = await prepareSampledAnimation(file, path.join(root, 'sampled'), 0.5, 8);
  assert.deepEqual(summary.sampled, { width: 8, height: 5, frames: 4, durationMs: 500, averageFps: 8 });
  const animation = await readAnimation(path.join(root, 'sampled/animation.json'));
  const reader = new GifReader(await fs.readFile(path.join(root, 'sampled/preview.gif')));
  assert.equal(reader.loopCount(), 4); assert.equal(reader.numFrames(), 4);
  assert.equal(reader.width, 8); assert.equal(reader.height, 5);
  assert.equal(animation.frames.reduce((n, f) => n + f.delayMs, 0), 500);
  assert.ok(animation.frames.every(f => f.opaque));
});
