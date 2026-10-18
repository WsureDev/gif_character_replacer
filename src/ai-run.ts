import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import OpenAI, { toFile } from 'openai';
import type { ImageEditParamsNonStreaming } from 'openai/resources/images';
import sharp from 'sharp';
import { imageClient, providerErrorBody, redactProviderText, type AiConfig } from './ai-config.js';
import { readAiPlan, type AiPlan } from './ai-plan.js';
import { ImageProcessor } from './image-processor.js';
import { createOutputDirectory, writeJson } from './manifests.js';
import { encodeGif } from './gif.js';
import { sha256, opaqueRgb } from './pixels.js';
import { cleanCrop } from './crop-cleanup.js';
import { markerPositions } from './fiducials.js';

export async function validateEditedSheet(bytes: Buffer, plan: AiPlan, contentEdgeTolerance = 0) {
  if (!Number.isInteger(contentEdgeTolerance) || contentEdgeTolerance < 0 || contentEdgeTolerance > 2) throw new Error('Invalid content-edge tolerance.');
  const meta = await sharp(bytes).metadata();
  const dimensionsMatch = meta.width === plan.layout.width && meta.height === plan.layout.height;
  if (!dimensionsMatch || meta.format !== 'png' || (meta.pages ?? 1) !== 1) return {
    passed: false, dimensionsMatch, actualSize: `${meta.width}x${meta.height}`, format: meta.format,
    reason: 'Unexpected dimensions/format; output retained without resizing or splitting.',
  };
  const rgba = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const mask = new Uint8Array(plan.layout.width * plan.layout.height);
  // Registered rectangles round inward; their excluded antialiased edge is not white paper.
  // This mask affects validation only, never the tighter crop used for output frames.
  for (const c of plan.layout.cells) for (let y = Math.max(0, c.y - contentEdgeTolerance); y < Math.min(plan.layout.height, c.y + c.height + contentEdgeTolerance); y++) {
    mask.fill(1, y * plan.layout.width + Math.max(0, c.x - contentEdgeTolerance),
      y * plan.layout.width + Math.min(plan.layout.width, c.x + c.width + contentEdgeTolerance));
  }
  if (plan.fiducials) for (const marker of markerPositions(plan.layout)) {
    for (let y = Math.max(0, marker.y - 2); y < Math.min(plan.layout.height, marker.y + 7); y++) {
      mask.fill(1, y * plan.layout.width + Math.max(0, marker.x - 2), y * plan.layout.width + Math.min(plan.layout.width, marker.x + 7));
    }
  }
  let alphaPixels = 0, gutterPixels = 0, changedGutterPixels = 0, gutterError = 0;
  for (let p = 0; p < mask.length; p++) {
    if (rgba[p * 4 + 3] !== 255) alphaPixels++;
    if (mask[p]) continue;
    gutterPixels++;
    const dr = 255 - rgba[p * 4]!, dg = 255 - rgba[p * 4 + 1]!, db = 255 - rgba[p * 4 + 2]!;
    gutterError += (dr + dg + db) / 3;
    if (Math.max(dr, dg, db) > 20) changedGutterPixels++;
  }
  const changedFraction = gutterPixels ? changedGutterPixels / gutterPixels : 0;
  return { passed: alphaPixels === 0 && changedFraction <= 0.08, dimensionsMatch, format: meta.format,
    actualSize: `${meta.width}x${meta.height}`, nonOpaquePixels: alphaPixels,
    gutterPixels, changedGutterFraction: changedFraction, gutterMeanError: gutterPixels ? gutterError / gutterPixels : 0, contentEdgeTolerance,
    requiresVisualReview: true,
    scope: 'Size, alpha and white padding checks only. Character identity, action and scene preservation require visual review.',
  };
}

export async function makePreviews(bytes: Buffer, plan: AiPlan, out: string, inputs: Map<string, Buffer>) {
  const images = new ImageProcessor();
  const { data: sheet, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgbSheet = opaqueRgb(sheet);
  await fs.mkdir(path.join(out, 'frames'));
  const restored: Buffer[] = [], original: Buffer[] = [];
  const cropReports = [];
  for (const [i, cell] of plan.layout.cells.entries()) {
    const source = await images.readPng(inputs.get(plan.frames[i]!.file)!, plan.source.width, plan.source.height);
    const cleaned = cleanCrop(sheet, info.width, cell, source, plan.source.width, plan.source.height);
    cropReports.push({ frame: i, registered: cell, ...cleaned });
    const c = cleaned.crop;
    const png = await sharp(rgbSheet, { raw: { width: info.width, height: info.height, channels: 3 } })
      .extract({ left: c.x, top: c.y, width: c.width, height: c.height })
      .resize(plan.source.width, plan.source.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    await fs.writeFile(path.join(out, 'frames', `frame-${String(i).padStart(4, '0')}.png`), png, { flag: 'wx' });
    restored.push(await images.readPng(png, plan.source.width, plan.source.height));
    original.push(source);
  }
  await writeJson(path.join(out, 'crop-report.json'), { policy: 'source-aware-white-trim + 2px-subpixel-guard + fill', frames: cropReports });
  const meta = { width: plan.source.width, height: plan.source.height, pixelAspectRatio: 0, loopCount: 0 };
  const delays = plan.frames.map(f => f.delayMs);
  const edited = encodeGif(restored, meta, delays, true);
  const source = encodeGif(original, meta, delays, true);
  await fs.writeFile(path.join(out, 'edited-preview.gif'), edited.bytes, { flag: 'wx' });
  await fs.writeFile(path.join(out, 'source-preview.gif'), source.bytes, { flag: 'wx' });
  return { frames: restored.length, durationMs: delays.reduce((a, b) => a + b, 0),
    outputBytes: edited.bytes.length, sourceExcerptBytes: source.bytes.length,
    quantizedFrames: edited.quantizedFrames, previewLoop: 'infinite; excerpt only, not a completed full-GIF edit' };
}

/** Exactly one Images Edits POST. An existing output directory always refuses resubmission. */
export async function runImageEdit(planFile: string, out: string, config: AiConfig, client?: OpenAI) {
  const plan = await readAiPlan(planFile);
  const base = path.dirname(planFile);
  const inputs = new Map<string, Buffer>();
  for (const entry of [plan.sheet, ...plan.references, plan.prompt]) {
    const bytes = await fs.readFile(path.join(base, entry.file));
    if (sha256(bytes) !== entry.sha256) throw new Error(`Plan input hash mismatch: ${entry.file}`);
    if (entry !== plan.prompt && bytes.length >= 50 * 1024 * 1024) throw new Error('Input image must be smaller than 50 MiB.');
    inputs.set(entry.file, bytes);
  }
  const images = new ImageProcessor();
  await images.readPng(inputs.get(plan.sheet.file)!, plan.layout.width, plan.layout.height);
  for (const frame of plan.frames) {
    const bytes = await fs.readFile(path.join(base, frame.file));
    if (sha256(await images.readPng(bytes, plan.source.width, plan.source.height)) !== frame.rgbaSha256) throw new Error('Source frame hash mismatch.');
    inputs.set(frame.file, bytes);
  }
  const prompt = inputs.get(plan.prompt.file)!.toString('utf8');
  if (prompt.length > 32000) throw new Error('Edit prompt exceeds 32000 characters.');
  await createOutputDirectory(out);
  await fs.mkdir(path.join(out, 'inputs'));
  for (const [file, bytes] of inputs) {
    const target = path.join(out, 'inputs', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  await writeJson(path.join(out, 'inputs/plan.json'), plan);
  const request = {
    clientRequestId: randomUUID(),
    endpoint: config.PROVIDER_SOURCE === 'browser' ? '[browser-provider]/images/edits' : `${config.OPENAI_BASE_URL}/images/edits`, model: config.OPENAI_IMAGE_MODEL,
    size: `${plan.layout.width}x${plan.layout.height}`, quality: config.OPENAI_IMAGE_QUALITY,
    background: 'opaque' as const, output_format: 'png' as const, n: 1,
    timeoutMs: config.OPENAI_IMAGE_TIMEOUT_MS, maxRetries: 0,
    inputImageOrder: [plan.sheet.file, ...plan.references.map(r => r.file)],
    planSha256: sha256(await fs.readFile(planFile)), promptVersion: plan.prompt.version,
  };
  await writeJson(path.join(out, 'request.json'), request);
  const writeState = async (state: object) => {
    await fs.writeFile(path.join(out, 'status.tmp'), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    await fs.rename(path.join(out, 'status.tmp'), path.join(out, 'status.json'));
  };
  // Reservation is durable before creating the billable request.
  await writeState({ state: 'in-flight', note: 'Do not resubmit this directory if the process exits without a result.' });
  const started = performance.now();
  let responseReceived = false;
  try {
    const uploads = await Promise.all(request.inputImageOrder.map(async file => toFile(inputs.get(file)!, file, { type: 'image/png' })));
    const params: ImageEditParamsNonStreaming = {
      model: request.model, image: uploads, prompt, background: 'opaque', output_format: 'png', n: 1,
      // SDK 6 supports this endpoint on Node 20; runtime values are validated against current 2.5 docs.
      size: request.size as ImageEditParamsNonStreaming['size'],
      quality: request.quality as ImageEditParamsNonStreaming['quality'],
    };
    let received;
    try {
      received = await (client ?? imageClient(config)).images.edit(params, { headers: { 'X-Client-Request-Id': request.clientRequestId } }).withResponse();
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        const payload = providerErrorBody(error), headers: Record<string, string> = {};
        for (const key of ['date', 'server', 'content-type', 'content-length', 'x-request-id', 'x-requestid', 'request-id', 'cf-ray', 'x-amzn-trace-id', 'retry-after']) {
          const value = error.headers?.get(key); if (value) headers[key] = value;
        }
        const diagnostic = JSON.stringify({ status: error.status, headers, clientRequestId: request.clientRequestId, body: payload,
          message: error.message, note: 'Base64 image fields are omitted here; valid image data is saved separately.' }, (key, value: unknown) =>
          key === 'b64_json' && typeof value === 'string' ? { omitted: true, characters: value.length } : value);
        await fs.writeFile(path.join(out, 'provider-error-response.json'), redactProviderText(diagnostic, config));
        const body = payload as { data?: { b64_json?: unknown }[] } | null | undefined;
        const encoded = body?.data?.[0]?.b64_json;
        if ((error.status ?? 0) >= 500 && Array.isArray(body?.data) && body.data.length === 1 && typeof encoded === 'string'
          && encoded.length > 0 && encoded.length <= 100 * 1024 * 1024 && /^[A-Za-z0-9+/=\s]+$/.test(encoded)) {
          // Recover an actual returned image despite a contradictory gateway status. No second request.
          received = { data: body as unknown as OpenAI.Images.ImagesResponse,
            response: new Response(null, { status: error.status, headers: error.headers }), request_id: error.requestID ?? null };
        } else throw error;
      } else throw error;
    }
    const { data, response, request_id } = received;
    responseReceived = true;
    const elapsedMs = Math.round(performance.now() - started);
    const requestId = request_id ?? response.headers.get('x-request-id');
    const raw = data as unknown as Record<string, unknown>;
    const parameterWarnings: string[] = [];
    if (!response.ok) parameterWarnings.push(`HTTP ${response.status} returned a complete base64 image; saved without retry and still subject to normal validation.`);
    if (typeof raw.quality === 'string' && raw.quality !== request.quality) parameterWarnings.push(`Requested quality ${request.quality}, provider reported ${raw.quality}.`);
    if (typeof raw.size === 'string' && raw.size !== request.size) parameterWarnings.push(`Requested size ${request.size}, provider reported ${raw.size}.`);
    if (typeof raw.background === 'string' && raw.background !== request.background) parameterWarnings.push(`Requested background ${request.background}, provider reported ${raw.background}.`);
    const metadata = { requestId, clientRequestId: request.clientRequestId, status: response.status, elapsedMs, created: data.created,
      recoveredFromHttpError: !response.ok,
      requestedModel: request.model, returnedModel: typeof raw.model === 'string' ? raw.model : null,
      requestedSize: request.size, requestedQuality: request.quality, parameterWarnings,
      reportedSize: raw.size ?? null, reportedBackground: raw.background ?? null, reportedQuality: raw.quality ?? null,
      usage: data.usage ?? null, imageCount: data.data?.length ?? 0 };
    await writeJson(path.join(out, 'response-metadata.json'), metadata);
    const encoded = data.data?.[0]?.b64_json;
    if (!encoded || data.data?.length !== 1 || !/^[A-Za-z0-9+/=\s]+$/.test(encoded) || encoded.length > 100 * 1024 * 1024) {
      throw new Error('Expected one base64 image response; no automatic URL download or regeneration was attempted.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    await fs.writeFile(path.join(out, 'edited-sheet.png'), bytes, { flag: 'wx' });
    const validation = await validateEditedSheet(bytes, plan);
    await writeJson(path.join(out, 'validation.json'), validation);
    // Marked sheets always go through measured feature registration, even if dimensions match.
    const previews = validation.passed && !plan.fiducials ? await makePreviews(bytes, plan, out, inputs) : null;
    const result = { ...metadata, validation, previews };
    await writeJson(path.join(out, 'result.json'), result);
    await writeState({ state: validation.passed ? 'completed-pending-visual-review' : 'validation-failed', requestId, elapsedMs });
    return result;
  } catch (error) {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    const payload = providerErrorBody(error) as { message?: unknown; detail?: unknown } | undefined;
    const providerMessage = typeof payload?.message === 'string' ? payload.message : typeof payload?.detail === 'string' ? payload.detail : '';
    const message = redactProviderText(`${error instanceof Error ? error.message : String(error)}${providerMessage ? ` · ${providerMessage}` : ''}`, config).slice(0, 4000);
    const requestId = error instanceof OpenAI.APIError ? error.requestID : null;
    const state = responseReceived ? 'output-processing-failed' : status ? 'http-failed' : 'unknown';
    await writeState({ state, status, requestId, message, elapsedMs: Math.round(performance.now() - started),
      clientRequestId: request.clientRequestId, outcomeUncertain: !responseReceived && (status === undefined || status >= 500),
      retryPolicy: 'No automatic retry. Unknown outcomes must be checked before any new request.' });
    throw new Error(`${state}: ${message}`);
  }
}
