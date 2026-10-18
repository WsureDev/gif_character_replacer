import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';
import { analyzeMotion } from '../src/motion-analysis.js';
import { sampleSelectedFrames } from '../src/sampling.js';

test('parallel full-timeline analysis preserves a fast ending after a long static opening', async () => {
  const width = 24, height = 16;
  const bytes = fixture(width, height, Array.from({ length: 90 }, (_, i) => ({
    pixels: Array(width * height).fill(i < 60 ? 2 : i % 3 + 3), options: { delay: 2 },
  })), 0);
  const analysis = await analyzeMotion(bytes, undefined, 4);
  assert.equal(analysis.adjacentPairsEvaluated, 89); assert.equal(analysis.workers, 4);
  assert.ok(analysis.adjacentScores.slice(1, 60).every(s => s === 0));
  assert.ok(analysis.adjacentScores.slice(60).every(s => s > 0.1));
  for (const p of analysis.presets) {
    assert.ok(p.frames < 40);
    assert.ok(p.indices.filter(i => i >= 60).length >= 29);
    assert.equal(p.indices.filter(i => i < 59).length, 1);
    const frames = sampleSelectedFrames(Array(90).fill(20), p.indices);
    assert.equal(frames.reduce((sum, f) => sum + f.delayMs, 0), 1800);
    for (const w of analysis.windows) if (w.motion >= 0.015) assert.ok(p.indices.includes(w.peakFrame));
  }
});

test('content-aware sampling combines identical holds and evaluates small localized motion', async () => {
  const still = fixture(16, 12, Array.from({ length: 40 }, () => ({ pixels: Array(192).fill(2), options: { delay: 2 } })), 0);
  const report = await analyzeMotion(still, undefined, 2);
  assert.equal(report.presets[0]!.frames, 1);
  assert.deepEqual(sampleSelectedFrames(Array(40).fill(20), report.presets[0]!.indices), [{ sourceIndex: 0, delayMs: 800 }]);
  const moving = fixture(48, 32, Array.from({ length: 30 }, (_, i) => ({
    pixels: Array.from({ length: 48 * 32 }, (_, p) => { const x = p % 48, y = Math.floor(p / 48); return x >= i && x < i + 5 && y >= 10 && y < 15 ? 1 : 0; }), options: { delay: 2 },
  })), 0);
  const motion = await analyzeMotion(moving, undefined, 3);
  assert.equal(motion.adjacentPairsEvaluated, 29);
  assert.ok(motion.presets.every(p => p.frames > 5));
  assert.ok(motion.windows.every(w => w.motion > 0));
});
