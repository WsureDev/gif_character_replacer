import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { assertImageSize, chooseLayout, candidateLayouts, fitLayout, validateAiLayout } from '../src/ai-layout.js';
import { prepareAiPlan } from '../src/ai-plan.js';
import { imageClient, type AiConfig } from '../src/ai-config.js';
import { runImageEdit, validateEditedSheet } from '../src/ai-run.js';
import { extract } from '../src/pipeline.js';
import { fixture } from './fixtures.js';
import { recoverLayout } from '../src/ai-recover.js';

const config: AiConfig = {
  OPENAI_BASE_URL: 'https://example.invalid/v1', OPENAI_API_KEY: 'test-secret-must-not-be-logged',
  OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst', OPENAI_IMAGE_QUALITY: 'medium', OPENAI_IMAGE_TIMEOUT_MS: 1000,
};

async function prepare(root: string) {
  await fs.writeFile(path.join(root, 'input.gif'), fixture(7, 5, [1, 2, 3, 4].map(color => ({ pixels: Array(35).fill(color), options: { delay: color } })), 0));
  await sharp({ create: { width: 30, height: 40, channels: 4, background: 'yellow' } }).png().toFile(path.join(root, 'ref.png'));
  await extract(path.join(root, 'input.gif'), path.join(root, 'frames'));
  return prepareAiPlan({ input: path.join(root, 'frames/animation.json'), reference: [path.join(root, 'ref.png')],
    out: path.join(root, 'plan'), frameCount: 4, size: '1024x1024', subject: 'the mascot', characterNotes: 'yellow character' });
}

test('AI layout enforces real size constraints and retains non-square aspect within one-pixel rounding', () => {
  for (const size of [[512, 512], [1025, 1024], [4096, 2048], [3840, 3840], [3072, 768]]) {
    assert.throws(() => assertImageSize(size[0]!, size[1]!));
  }
  for (const [w, h] of [[235, 235], [320, 482], [426, 238], [800, 800]]) {
    for (const count of [1, 4, 9, 12, 16, 20, 25]) {
      const layouts = candidateLayouts(w!, h!, count);
      assert.ok(layouts.length >= 3);
      for (const layout of layouts) {
        assert.doesNotThrow(() => validateAiLayout(layout));
        for (const cell of layout.cells) {
          assert.ok(Math.abs(cell.width / layout.scale - w!) < 1 / layout.scale + 1e-6);
          assert.ok(Math.abs(cell.height / layout.scale - h!) < 1 / layout.scale + 1e-6);
          assert.ok(cell.x + cell.width <= layout.width && cell.y + cell.height <= layout.height);
        }
      }
    }
  }
  const changed = chooseLayout(320, 482, 4, '1024x1536');
  changed.cells[0]!.x++;
  assert.throws(() => validateAiLayout(changed), /coordinates/);
});

test('dense 4x3 through 5x5 layouts fit low-resolution frames without a 3x3 ceiling', () => {
  for (const [columns, rows] of [[4, 3], [4, 4], [5, 4], [5, 5]] as const) {
    const layout = fitLayout(235, 235, columns * rows, 1280, 1280, columns, 8, 12);
    assert.equal(layout.rows, rows);
    assert.equal(layout.columns, columns);
    assert.equal(layout.cells.length, columns * rows);
    assert.ok(layout.cells.every(c => c.width >= 235 && c.height >= 235));
    assert.doesNotThrow(() => validateAiLayout(layout));
  }
});

test('SDK sends one multipart edit with ordered images, opaque PNG and requested model/size', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-ai-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepare(root);
  const png = await fs.readFile(path.join(root, 'plan/input-sheet.png'));
  let count = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    if (String(_url).startsWith('data:')) return new Response(''); // SDK local FormData capability probe.
    count++;
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${config.OPENAI_API_KEY}`);
    const form = init?.body as FormData;
    assert.equal(form.get('model'), config.OPENAI_IMAGE_MODEL);
    assert.equal(form.get('size'), '1024x1024');
    assert.equal(form.get('background'), 'opaque');
    assert.equal(form.get('output_format'), 'png');
    assert.equal(form.get('n'), '1');
    const files = form.getAll('image[]') as File[];
    assert.equal(files.length, 2);
    assert.equal(files[0]!.name, 'input-sheet.png');
    assert.equal(files[1]!.name, 'reference-1.png');
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'test-request' } });
  };
  const output = path.join(root, 'result');
  const result = await runImageEdit(path.join(root, 'plan/plan.json'), output, config, imageClient(config, mockFetch));
  assert.equal(count, 1);
  assert.equal(result.validation.passed, true);
  assert.equal(result.previews?.frames, 4);
  assert.equal(result.previews?.durationMs, 100);
  assert.equal(result.requestId, 'test-request');
  assert.equal(result.usage?.total_tokens, 30);
  assert.ok(!(await fs.readFile(path.join(output, 'request.json'), 'utf8')).includes(config.OPENAI_API_KEY));
  await assert.rejects(runImageEdit(path.join(root, 'plan/plan.json'), output, config, imageClient(config, mockFetch)), /EEXIST/);
  assert.equal(count, 1);
});

test('HTTP failures and connection-unknown outcomes are recorded without retry or secret leakage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-ai-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepare(root);
  for (const kind of ['http', 'connection']) {
    let count = 0;
    const mockFetch: typeof fetch = async url => {
      if (String(url).startsWith('data:')) return new Response('');
      count++;
      if (kind === 'connection') throw new TypeError('Connection closed after sending request');
      return new Response(JSON.stringify({ error: { message: `Bad key ${config.OPENAI_API_KEY}`, type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    };
    const out = path.join(root, kind);
    await assert.rejects(runImageEdit(path.join(root, 'plan/plan.json'), out, config, imageClient(config, mockFetch)));
    assert.equal(count, 1);
    const text = await fs.readFile(path.join(out, 'status.json'), 'utf8');
    assert.ok(!text.includes(config.OPENAI_API_KEY));
    assert.equal(JSON.parse(text).state, kind === 'http' ? 'http-failed' : 'unknown');
  }
});

test('a gateway 504 carrying a complete image is retained and validated without a second request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-504-image-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepare(root);
  const png = await fs.readFile(path.join(root, 'plan/input-sheet.png'));
  let requests = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    if (String(url).startsWith('data:')) return new Response('');
    requests++; assert.ok(new Headers(init?.headers).get('X-Client-Request-Id'));
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }),
      { status: 504, headers: { 'content-type': 'application/json', 'x-request-id': 'provider-request-504' } });
  };
  const out = path.join(root, 'result'), result = await runImageEdit(path.join(root, 'plan/plan.json'), out, config, imageClient(config, fetchMock));
  assert.equal(requests, 1); assert.equal(result.status, 504); assert.equal(result.recoveredFromHttpError, true);
  assert.equal(result.validation.passed, true); assert.equal(result.previews?.frames, 4);
  assert.deepEqual(await fs.readFile(path.join(out, 'edited-sheet.png')), png);
  assert.equal(result.requestId, 'provider-request-504');
  const diagnostic = JSON.parse(await fs.readFile(path.join(out, 'provider-error-response.json'), 'utf8'));
  assert.equal(diagnostic.body.data[0].b64_json.omitted, true);
  assert.equal(diagnostic.headers['x-request-id'], 'provider-request-504');
});

test('nonstandard timeout JSON preserves provider details while treating the outcome as uncertain', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-504-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepare(root); let requests = 0;
  const fetchMock: typeof fetch = async url => {
    if (String(url).startsWith('data:')) return new Response('');
    requests++;
    return new Response(JSON.stringify({ message: `Upstream timed out ${config.OPENAI_API_KEY}`, task_id: 'remote-job-1' }),
      { status: 504, headers: { 'content-type': 'application/json', 'cf-ray': 'trace-504', 'set-cookie': 'must-not-record' } });
  };
  const out = path.join(root, 'result');
  await assert.rejects(runImageEdit(path.join(root, 'plan/plan.json'), out, config, imageClient(config, fetchMock)), /Upstream timed out/);
  assert.equal(requests, 1);
  const diagnostic = await fs.readFile(path.join(out, 'provider-error-response.json'), 'utf8');
  assert.ok(!diagnostic.includes(config.OPENAI_API_KEY)); assert.ok(!diagnostic.includes('must-not-record'));
  assert.equal(JSON.parse(diagnostic).body.task_id, 'remote-job-1');
  const state = JSON.parse(await fs.readFile(path.join(out, 'status.json'), 'utf8'));
  assert.equal(state.status, 504); assert.equal(state.outcomeUncertain, true); assert.ok(state.clientRequestId);
  await assert.rejects(fs.access(path.join(out, 'edited-sheet.png')));
});

test('unexpected alpha or canvas changes fail validation without automatic flattening/resizing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-ai-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = await prepare(root);
  const transparent = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
  const wrongSize = await sharp(transparent).resize(1536, 1024).png().toBuffer();
  assert.equal((await validateEditedSheet(transparent, plan)).passed, false);
  assert.equal((await validateEditedSheet(wrongSize, plan)).dimensionsMatch, false);
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: transparent.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await runImageEdit(path.join(root, 'plan/plan.json'), path.join(root, 'result'), config, imageClient(config, mockFetch));
  assert.equal(result.validation.passed, false);
  assert.equal(result.previews, null);
  assert.deepEqual(await fs.readFile(path.join(root, 'result/edited-sheet.png')), transparent);
});

test('offline recovery requires both near-uniform scaling and observed white gutters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-character-replacer-ai-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = await prepare(root);
  const input = await fs.readFile(path.join(root, 'plan/input-sheet.png'));
  const scaled = await sharp(input).resize(1254, 1254).png().toBuffer();
  const recovered = await recoverLayout(scaled, plan);
  assert.equal(recovered.registration.actualSize, '1254x1254');
  assert.equal(recovered.registration.validation.passed, true);
  assert.equal(recovered.derived.layout.cells.length, 4);
  const distorted = await sharp(input).resize(1254, 1300).png().toBuffer();
  await assert.rejects(recoverLayout(distorted, plan), /not uniformly scaled/);
  const missingGutters = await sharp({ create: { width: 1254, height: 1254, channels: 4, background: 'red' } }).png().toBuffer();
  await assert.rejects(recoverLayout(missingGutters, plan), /No reliable white band/);
});
