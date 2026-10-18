import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GifReader } from 'omggif';
import { decodeGif, encodeGif, inspectGif } from '../src/gif.js';
import { isOpaque, comparePixels } from '../src/pixels.js';
import { COLORS, fixture, interlacedFixture, pixel } from './fixtures.js';

test('raw 0/10/70 ms delays, duplicate frames and absent/finite/infinite loop survive', async () => {
  for (const loop of [undefined, 0, 3]) {
    const source = fixture(3, 2, [0, 1, 7].map(delay => ({ pixels: [1, 2, 3, 1, 2, 3], options: { delay, disposal: 1 } })), loop);
    const decoded = await decodeGif(source);
    assert.deepEqual(decoded.metadata.frames.map(f => f.delayMs), [0, 10, 70]);
    assert.equal(decoded.metadata.loopCount, loop ?? null);
    const encoded = encodeGif(decoded.frames, decoded.metadata, decoded.metadata.frames.map(f => f.delayMs));
    const independent = new GifReader(encoded.bytes);
    assert.equal(independent.loopCount(), loop ?? null);
    assert.equal(independent.numFrames(), 3);
    assert.deepEqual([0, 1, 2].map(i => independent.frameInfo(i).delay), [0, 1, 7]);
    const roundtrip = await decodeGif(encoded.bytes);
    for (let i = 0; i < 3; i++) assert.deepEqual(roundtrip.frames[i], decoded.frames[i]);
  }
});

test('delta transparency leaves the white background opaque, including white character pixels', async () => {
  const source = fixture(4, 3, [
    { pixels: Array(12).fill(1), options: { delay: 2, disposal: 1 } },
    { x: 1, y: 1, width: 2, height: 1, pixels: [2, 0], options: { delay: 3, disposal: 1, transparent: 0 } },
  ]);
  const { frames, metadata } = await decodeGif(source);
  assert.equal(metadata.frames[1]!.transparentIndex, 0);
  assert.ok(frames.every(isOpaque));
  assert.deepEqual(pixel(frames[1]!, 4, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(frames[1]!, 4, 2, 1), [255, 255, 255, 255]);
});

test('disposal 3 restores previous canvas and local palettes are honored', async () => {
  const source = fixture(4, 3, [
    { pixels: Array(12).fill(1), options: { delay: 2, disposal: 0 } },
    { x: 1, y: 1, width: 1, height: 1, pixels: [2], options: { delay: 3, disposal: 3 } },
    { x: 2, y: 1, width: 1, height: 1, pixels: [2], options: { delay: 4, disposal: 1, palette: [0, 0xffffff, 0x0000ff, 0] } },
  ]);
  const { frames, metadata } = await decodeGif(source);
  assert.deepEqual(pixel(frames[1]!, 4, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(frames[2]!, 4, 1, 1), [255, 255, 255, 255]);
  assert.deepEqual(pixel(frames[2]!, 4, 2, 1), [0, 0, 255, 255]);
  assert.equal(metadata.frames[2]!.localPalette, true);
});

test('disposal 2 clears a transparent patch; full-frame GIF encoding leaves no ghost', async () => {
  const source = fixture(4, 3, [
    { pixels: [0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0], options: { delay: 4, disposal: 2, transparent: 0 } },
    { x: 2, y: 1, width: 1, height: 1, pixels: [3], options: { delay: 5, disposal: 2, transparent: 0 } },
  ], 0);
  const decoded = await decodeGif(source);
  assert.deepEqual(pixel(decoded.frames[1]!, 4, 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(decoded.frames[1]!, 4, 2, 1), [0, 255, 0, 255]);
  const result = await decodeGif(encodeGif(decoded.frames, decoded.metadata, [40, 50]).bytes);
  assert.deepEqual(result.frames, decoded.frames);
});

test('mixed opaque and transparent displayed frames survive full-frame encoding', async () => {
  const source = fixture(3, 2, [
    { pixels: [1, 1, 1, 1, 1, 1], options: { delay: 3, disposal: 2 } },
    { pixels: [0, 2, 0, 0, 0, 0], options: { delay: 4, disposal: 2, transparent: 0 } },
    { pixels: [3, 3, 3, 3, 3, 3], options: { delay: 5, disposal: 2 } },
  ]);
  const decoded = await decodeGif(source);
  const result = await decodeGif(encodeGif(decoded.frames, decoded.metadata, [30, 40, 50]).bytes);
  assert.deepEqual(result.frames, decoded.frames);
});

test('missing GCE is reported without inventing a delay', async () => {
  const source = fixture(2, 1, [{ pixels: [1, 2] }]);
  const decoded = await decodeGif(source);
  assert.equal(decoded.metadata.frames[0]!.hasGraphicControl, false);
  assert.equal(decoded.metadata.frames[0]!.delayMs, 0);
});

test('comments and application blocks do not detach control data from the next frame', async () => {
  const source = fixture(2, 1, [{ pixels: [1, 2], options: { delay: 11, disposal: 3 } }]);
  const afterControl = source.indexOf(Buffer.from([0x21, 0xf9, 4])) + 8;
  const intervening = Buffer.concat([
    Buffer.from([0x21, 0xfe, 1, 0x41, 0]),
    Buffer.from([0x21, 0xff, 11]), Buffer.from('TESTAPP1000'), Buffer.from([1, 0x42, 0]),
  ]);
  const decoded = await decodeGif(Buffer.concat([source.subarray(0, afterControl), intervening, source.subarray(afterControl)]));
  assert.equal(decoded.metadata.frames[0]!.delayMs, 110);
  assert.equal(decoded.metadata.frames[0]!.disposal, 3);
});

test('interlaced images decode into display row order', async () => {
  const decoded = await decodeGif(interlacedFixture());
  assert.equal(decoded.metadata.frames[0]!.interlaced, true);
  for (let y = 0; y < 9; y++) {
    const rgb = COLORS[y % 8]!;
    assert.deepEqual(pixel(decoded.frames[0]!, 2, 0, y), [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255]);
  }
});

test('palette overflow requires explicit quantization and reports affected frames', async () => {
  const frame = Buffer.alloc(20 * 20 * 4);
  for (let i = 0; i < 400; i++) frame.set([i % 256, Math.floor(i / 256), i % 31, 255], i * 4);
  const metadata = { width: 20, height: 20, loopCount: null, pixelAspectRatio: 0 };
  assert.throws(() => encodeGif([frame], metadata, [20]), /palette capacity/);
  const result = encodeGif([frame], metadata, [20], true);
  assert.deepEqual(result.quantizedFrames, [0]);
  const roundtrip = await decodeGif(result.bytes);
  assert.equal(comparePixels(frame, roundtrip.frames[0]!).alphaErrors, 0);
});

test('unsupported or corrupt metadata fails instead of silently changing timing', () => {
  assert.throws(() => inspectGif(Buffer.from('not a gif')), /not a GIF/);
  const frame = Buffer.from([255, 255, 255, 128]);
  const meta = { width: 1, height: 1, loopCount: null, pixelAspectRatio: 0 };
  assert.throws(() => encodeGif([frame], meta, [11]), /multiple of 10/);
  assert.throws(() => encodeGif([frame], meta, [10]), /partial alpha/);
  assert.throws(() => encodeGif([frame], { ...meta, pixelAspectRatio: 256 }, [10]), /aspect/);
});

test('native GIF round trips preserve valid pixel aspect bytes, including explicit square pixels (49)', async () => {
  for (const aspect of [0, 49, 17, 113, 255]) {
    const source = fixture(4, 3, [0, 1, 7].map(delay => ({ pixels: Array(12).fill(2), options: { delay } })), 3);
    source[12] = aspect;
    const decoded = await decodeGif(source), encoded = encodeGif(decoded.frames, decoded.metadata, [0, 10, 70]);
    assert.equal(encoded.bytes[12], aspect);
    const restored = await decodeGif(encoded.bytes);
    assert.equal(restored.metadata.pixelAspectRatio, aspect); assert.deepEqual(restored.frames, decoded.frames);
    assert.equal(restored.metadata.loopCount, 3); assert.equal(restored.metadata.durationMs, 80);
  }
});
