import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { readAnimation, createOutputDirectory, writeJson } from './manifests.js';
import { ImageProcessor } from './image-processor.js';
import { sha256, isOpaque } from './pixels.js';
import { aiLayoutSchema, candidateLayouts, chooseLayout, fitLayout, parseImageSize, validateAiLayout, type AiLayout } from './ai-layout.js';
import { pixelAspectRatio } from './pixel-aspect.js';
import { drawFiducials, fiducialSchema, FIDUCIALS } from './fiducials.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const localFile = z.string().regex(/^[a-zA-Z0-9._/-]+$/).refine(p => !p.startsWith('/') && !p.split('/').includes('..'));
export const aiPlanSchema = z.object({
  version: z.literal(1), kind: z.literal('image-edit-experiment'),
  source: z.object({ name: z.string(), sha256: digest, width: z.number().int().positive(), height: z.number().int().positive(),
    totalFrames: z.number().int().positive(), loopCount: z.number().int().nonnegative().nullable() }),
  frames: z.array(z.object({ sourceIndex: z.number().int().nonnegative(), delayMs: z.number().int().nonnegative(), file: localFile, rgbaSha256: digest })),
  layout: aiLayoutSchema, background: z.literal('opaque'),
  fiducials: fiducialSchema.optional(),
  sheet: z.object({ file: localFile, sha256: digest }),
  references: z.array(z.object({ file: localFile, sha256: digest })).min(1).max(15),
  prompt: z.object({ file: localFile, sha256: digest, version: z.string() }),
}).strict();
export type AiPlan = z.infer<typeof aiPlanSchema>;

export interface PromptContext { referenceCount?: number; appearanceReference?: boolean; registrationMarkers?: boolean }
export function replacementPrompt(layout: AiLayout, subject: string, characterNotes: string, extra = '', context: PromptContext = {}): string {
  const referenceCount = context.referenceCount ?? 1, identityCount = referenceCount - (context.appearanceReference ? 1 : 0);
  if (!Number.isInteger(referenceCount) || referenceCount < 1 || referenceCount > 15 || identityCount < 1) throw new Error('Invalid prompt reference roles.');
  const first = layout.cells[0]!;
  const coordinates = layout.frameCount <= 64
    ? layout.cells.map((c, i) => `Cell ${i + 1}: (${c.x},${c.y},${c.width},${c.height})`).join('\n')
    : `All content cells are ${first.width}x${first.height}. For zero-based column c and row r: x=${first.x}+c*${layout.columns > 1 ? layout.cells[1]!.x - first.x : 0}; y=${first.y}+r*${layout.rows > 1 ? layout.cells[layout.columns]!.y - first.y : 0}. Cell index is r*${layout.columns}+c; only indexes below ${layout.frameCount} are active.`;
  const identities = identityCount === 1 ? 'IMAGE 2' : `IMAGES 2 through ${identityCount + 1}`;
  const anchor = context.appearanceReference
    ? `IMAGE ${referenceCount + 1} is the APPROVED EDITED FRAME from this same animation, shared across all batches. Match its accepted character design, proportions, clothing, palette, material, rendering style and lighting treatment. It is an APPEARANCE reference only: its pose, gaze, eyelids, mouth shape and expression must NEVER override the corresponding cell of IMAGE 1. Do not copy this single frame across the sequence.` : '';
  return `TASK / 核心任务
This is a frame-by-frame composite of a GIF; the main character needs to be replaced in each frame while maintaining the overall continuity of the GIF. Keep the main character's original pose, demeanor and facial expression UNCHANGED in every corresponding frame; replace only its character identity using the supplied character references.
用这个替代角色替换逐帧图中的 main character，保留 main character 的姿势、神态、表情不变，注意每一帧之间连贯。这是逐帧人设替换，不是重新创作动作，也不是根据人设图重画一段动画。

INPUT ROLES / 输入分工
IMAGE 1 is the source contact sheet and the only authority for each frame's action, pose, expression, gaze, orientation, scene and composition.
${identities} ${identityCount === 1 ? 'is' : 'are'} the replacement CHARACTER IDENTITY reference: anatomy/design, face shape, costume, hair/fur, markings and colors. Their own pose, expression, camera and background are NOT to be transferred.
${anchor}

FRAME-LOCKED REQUIREMENTS / 每帧必须遵守（优先于人设图或基准图中的动作表情）
1. ONE-TO-ONE: output cell i must be an edit of source cell i, not another frame. Match its exact action phase. Keep the body pose, head yaw/pitch/roll, torso lean, front/side/back orientation, limb directions, hand gestures, support points and prop contacts. Do not mirror the character, reverse left/right, turn a back view into a front view, invent limbs, or substitute a more attractive pose.
2. EXPRESSION LOCK: preserve each frame's demeanor and emotional intensity, eyebrow angle, gaze direction, eyelid opening/closing, blink phase, mouth opening/closing, mouth shape and smile/frown state. Closed eyes must remain closed; an open mouth must not become a closed smile. Adapt these states to the replacement face WITHOUT changing their meaning or timing. Do not give every frame the reference picture's expression.
3. POSITION LOCK: keep the character's screen position, framing, visible body extent, motion silhouette, relative size and occlusion relationships. Use the replacement anatomy without redesigning the source motion. Keep hands/feet aligned with their original contact points and retain the same held props. Change contact shadows only where the replacement actually requires it.
4. TEMPORAL CONTINUITY: read cells left-to-right, top-to-bottom. Preserve the source progression, including pauses, blinks, turns, extremes and repeated poses. Keep replacement identity, facial structure, outfit, colors, material and rendering style stable throughout this sheet and across batches. Do not shuffle frames, repeat a convenient pose in different cells, invent in-between poses, smooth away expressions, or restart the action at a new row. Where this sheet skips time, follow the actual source poses; do not invent a continuous action between unrelated cells.
5. SCENE LOCK: preserve background, camera, perspective, crop, other characters, props and existing text in each corresponding cell. Do not import the reference background, add objects, move the camera, zoom, decorate, relight the whole scene, add captions or watermarks.

TARGET DESCRIPTION / 用户指定的替换目标或任务说明（独立字段）
${subject.trim() || 'the main character'}

CHARACTER NOTES / 用户补充的人设与替换要求
${characterNotes.trim() || '以人设参考图确定替代角色的外观；动作、神态、表情以每张原帧为准。'}

LAYOUT LOCK / 拼版几何约束
Return ONE opaque PNG of exactly ${layout.width}x${layout.height} pixels. Keep exactly ${layout.columns} columns, ${layout.rows} rows and ${layout.frameCount} active cells. Do not merge, reorder, duplicate, add or omit cells. Content rectangles (x,y,width,height):
${coordinates}
Keep white gutters, outer padding and unused cells unchanged. Edit only inside each active content rectangle. No drawing across boundaries; no new inner white border, letterbox, frame number or cell label.
${context.registrationMarkers ? 'REGISTRATION MARKERS: Preserve EVERY tiny colored corner marker (magenta top-left, cyan top-right, green bottom-left, orange bottom-right), including its dark center, exact position, size, shape and color. These are alignment features outside the content, not scene objects. Keep the surrounding paper opaque white.' : ''}
All input scene pixels are OPAQUE. White areas are real background paint. Keep backgrounds and alpha fully opaque; never remove backgrounds, add transparency or draw a checkerboard.

ADDITIONAL USER INSTRUCTIONS / 其他补充（仍须满足上述逐帧动作、表情与布局约束）
${extra.trim() || '无。'}

BEFORE RETURNING / 输出前逐格核对
Compare each output cell directly with the SAME source cell: pose/orientation, gaze, eyelids, mouth, emotion, position and prop contacts must match; only character identity is replaced. Then verify consistent identity across all cells, unchanged cell count/order/borders/markers, and unchanged surrounding scenes. Return only the edited sheet.`;
}

export async function prepareAiPlan(options: { input: string; reference: string[]; out: string; frameCount: number;
  startFrame?: number; size?: string; columns?: number; gutter?: number; margin?: number;
  subject: string; characterNotes: string; extraPrompt?: string; promptVersion?: string; registrationMarkers?: boolean; appearanceReference?: boolean }) {
  if (options.registrationMarkers) options = { ...options, gutter: Math.max(16, options.gutter ?? 16), margin: Math.max(12, options.margin ?? 12) };
  const animation = await readAnimation(options.input);
  if (pixelAspectRatio(animation.pixelAspectRatio) !== 1) throw new Error('请先通过 Web 采样将非方形像素转换为显示比例正确的方形像素，再准备 AI 拼版。');
  const start = options.startFrame ?? 0;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(options.frameCount) || options.frameCount < 1
    || options.frameCount > 10000 || start + options.frameCount > animation.frames.length) throw new Error('Invalid frame range.');
  const selected = animation.frames.slice(start, start + options.frameCount);
  if (selected.some(f => !f.opaque)) throw new Error('Initial AI experiment supports opaque displayed frames only.');
  if (options.reference.length < 1 || options.reference.length > 15) throw new Error('Provide 1..15 character reference images.');
  // Explicit capacity-derived layouts avoid the O(frameCount²) all-column search.
  const candidates = options.size && options.columns ? [] : candidateLayouts(animation.width, animation.height, selected.length);
  let layout: AiLayout;
  if (options.size && options.columns) {
    const [width, height] = parseImageSize(options.size);
    layout = fitLayout(animation.width, animation.height, selected.length, width, height, options.columns, options.gutter ?? 16, options.margin ?? 16);
  } else {
    const baseline = options.size ? chooseLayout(animation.width, animation.height, selected.length, options.size) : candidates[0]!;
    layout = fitLayout(animation.width, animation.height, selected.length, baseline.width, baseline.height,
      options.columns ?? baseline.columns, options.gutter ?? baseline.gutter, options.margin ?? baseline.margin);
  }
  await createOutputDirectory(options.out);
  await fs.mkdir(path.join(options.out, 'source'));
  const images = new ImageProcessor();
  const frames: AiPlan['frames'] = [];
  const parts = [];
  for (const [i, frame] of selected.entries()) {
    const bytes = await fs.readFile(path.join(path.dirname(options.input), frame.file));
    const rgba = await images.readPng(bytes, animation.width, animation.height);
    if (sha256(rgba) !== frame.rgbaSha256 || !isOpaque(rgba)) throw new Error('Source frame differs from manifest.');
    const file = `source/frame-${String(i).padStart(4, '0')}.png`;
    await fs.writeFile(path.join(options.out, file), bytes, { flag: 'wx' });
    frames.push({ sourceIndex: frame.index, delayMs: frame.delayMs, file, rgbaSha256: frame.rgbaSha256 });
    const cell = layout.cells[i]!;
    const resized = await sharp(bytes).resize(cell.width, cell.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    parts.push({ input: resized, rect: cell });
  }
  const plainSheet = await images.stitchSheet(parts, layout.width, layout.height, true);
  const sheet = options.registrationMarkers ? await drawFiducials(plainSheet, layout) : plainSheet;
  await fs.writeFile(path.join(options.out, 'input-sheet.png'), sheet, { flag: 'wx' });
  const references: AiPlan['references'] = [];
  for (const [i, reference] of options.reference.entries()) {
    const png = await sharp(await fs.readFile(reference)).rotate().png().toBuffer();
    const file = `reference-${i + 1}.png`;
    await fs.writeFile(path.join(options.out, file), png, { flag: 'wx' });
    references.push({ file, sha256: sha256(png) });
  }
  const prompt = replacementPrompt(layout, options.subject, options.characterNotes, options.extraPrompt, {
    referenceCount: references.length, appearanceReference: options.appearanceReference, registrationMarkers: options.registrationMarkers });
  await fs.writeFile(path.join(options.out, 'prompt.txt'), prompt, { flag: 'wx' });
  const plan: AiPlan = { version: 1, kind: 'image-edit-experiment',
    source: { name: animation.source.name, sha256: animation.source.sha256, width: animation.width, height: animation.height,
      totalFrames: animation.frames.length, loopCount: animation.loopCount },
    frames, layout, background: 'opaque', ...(options.registrationMarkers ? { fiducials: FIDUCIALS } : {}), sheet: { file: 'input-sheet.png', sha256: sha256(sheet) }, references,
    prompt: { file: 'prompt.txt', sha256: sha256(Buffer.from(prompt)), version: options.promptVersion ?? 'pose-expression-locked-v3' } };
  await writeJson(path.join(options.out, 'plan.json'), plan);
  await writeJson(path.join(options.out, 'layout-candidates.json'), { basis: 'Geometry heuristic, not measured AI quality or cost', candidates });
  return plan;
}

export async function readAiPlan(file: string): Promise<AiPlan> {
  const plan = aiPlanSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  validateAiLayout(plan.layout);
  if (plan.frames.length !== plan.layout.frameCount || plan.source.width !== plan.layout.sourceWidth
    || plan.source.height !== plan.layout.sourceHeight) throw new Error('Plan source/layout mismatch.');
  for (const [i, frame] of plan.frames.entries()) {
    if (frame.delayMs % 10 || frame.delayMs > 655350 || frame.sourceIndex >= plan.source.totalFrames
      || (i > 0 && frame.sourceIndex !== plan.frames[i - 1]!.sourceIndex + 1)) throw new Error('Invalid plan frame timing/order.');
  }
  return plan;
}
