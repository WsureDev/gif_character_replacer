import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { type AiConfig } from './ai-config.js';
import { assetDir, createTask, draftFingerprint, providerIdentity, readTask, taskDir, writeTask, type Asset, type Task } from './lab-store.js';
import { readAnimation, writeJson } from './manifests.js';
import { sha256, isOpaque } from './pixels.js';

const actionSchema = z.object({ operationId: z.string().uuid(), draftHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['trial', 'approve']), frameIndex: z.number().int().nonnegative().optional(), trialId: z.string().uuid().optional(), imageSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
  .refine(a => a.kind === 'trial' ? a.frameIndex !== undefined && !a.trialId && !a.imageSha256 : a.trialId !== undefined && a.imageSha256 !== undefined && a.frameIndex === undefined);

export async function trialImage(root: string, trial: Task) {
  if (trial.status !== 'completed' || !trial.result || !trial.trialFor) return undefined;
  const directory = path.dirname(trial.result.file), animation = await readAnimation(path.join(taskDir(root, trial.id), directory, 'animation.json'));
  if (animation.frames.length !== 1) throw new Error('试生成结果必须只有一帧。');
  const file = `${directory}/${animation.frames[0]!.file}`, bytes = await fs.readFile(path.join(taskDir(root, trial.id), file));
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!isOpaque(data) || sha256(data) !== animation.frames[0]!.rgbaSha256 || info.width !== animation.width || info.height !== animation.height) throw new Error('试生成结果图校验失败。');
  return { file, sha256: sha256(bytes), bytes, width: info.width, height: info.height };
}

/** Creates a separately audited one-image trial, or an offline guided draft. Never submits the guided draft. */
export async function approveAnchorAction(root: string, id: string, input: unknown, config: AiConfig) {
  const action = actionSchema.parse(input), parent = await readTask(root, id), dir = taskDir(root, id);
  if (parent.settings.anchorMode !== 'frame' || parent.status !== 'draft' || !parent.draftHash || parent.draftHash !== action.draftHash) throw new Error('请重新打开已准备好的基准帧实验草稿。');
  if (await draftFingerprint(dir, parent.settings, parent.provider) !== parent.draftHash) throw new Error('草稿输入已变化，请重新生成预览。');
  const replayTrial = parent.anchorTrials?.find(t => t.operationId === action.operationId);
  const replayApproval = parent.anchorApprovals?.find(t => t.operationId === action.operationId);
  if (replayTrial || replayApproval) return { task: await readTask(root, replayTrial?.id ?? replayApproval!.taskId), enqueued: false };
  if (action.kind === 'trial') {
    if (parent.provider?.signature !== providerIdentity(config).signature) throw new Error('接口配置已变化，请重新生成草稿后试生成。');
    const frame = parent.sampling?.mapping[action.frameIndex!];
    if (!frame) throw new Error('所选帧超出当前采样范围。');
    for (const entry of parent.anchorTrials ?? []) if (['preparing', 'queued', 'running'].includes((await readTask(root, entry.id)).status)) throw new Error('请等待当前试生成完成，再生成其他效果。');
    const settings = { ...parent.settings, anchorMode: 'off', anchorTrialFrame: frame.sourceIndex, dedupMode: 'off', maxFps: 0, maxFramesPerSheet: 1, outputSize: 'sampled' };
    delete settings.frameCount; delete settings.smartPreset; delete settings.anchorSourceFrame;
    const trial = await createTask(root, { gifAsset: parent.gifAsset, referenceAssets: parent.referenceAssets,
      name: `试生成 · 第 ${action.frameIndex! + 1} 帧 · ${parent.name}`.slice(0, 120), settings }, providerIdentity(config));
    await copySnapshots(root, parent, trial);
    trial.trialFor = { taskId: id, frameIndex: action.frameIndex!, sourceIndex: frame.sourceIndex, autoSubmit: true };
    await writeTask(root, trial);
    parent.anchorTrials = [...(parent.anchorTrials ?? []), { id: trial.id, operationId: action.operationId, frameIndex: action.frameIndex! }];
    await writeTask(root, parent);
    return { task: trial, enqueued: true };
  }
  if (!parent.anchorTrials?.some(t => t.id === action.trialId)) throw new Error('该试生成不属于此草稿。');
  const trial = await readTask(root, action.trialId!), image = await trialImage(root, trial);
  if (!image || trial.trialFor?.taskId !== id || image.sha256 !== action.imageSha256) throw new Error('试生成效果已变化或尚未完成，请重新预览后确认。');
  if (await draftFingerprint(taskDir(root, trial.id), trial.settings, trial.provider) !== trial.draftHash) throw new Error('试生成输入已变化，不能确认。');
  const referenceId = randomUUID(), asset: Asset = { id: referenceId, kind: 'reference', name: `已确认基准帧 ${trial.trialFor.frameIndex + 1}`, file: 'reference.png',
    bytes: image.bytes.length, width: image.width, height: image.height };
  await fs.mkdir(assetDir(root, referenceId));
  await fs.writeFile(path.join(assetDir(root, referenceId), asset.file), image.bytes, { flag: 'wx' });
  await writeJson(path.join(assetDir(root, referenceId), 'asset.json'), asset);
  const settings = { ...parent.settings, anchorMode: 'off', anchorSourceFrame: trial.trialFor.sourceIndex };
  delete settings.anchorTrialFrame;
  const guided = await createTask(root, { gifAsset: parent.gifAsset, referenceAssets: [...parent.referenceAssets, referenceId], settings,
    name: `基准帧已确认 · ${parent.name}`.slice(0, 120) }, providerIdentity(config));
  await copySnapshots(root, parent, guided);
  guided.guidedFrom = { taskId: id, trialId: trial.id, imageSha256: image.sha256, imageFile: `references/reference-${guided.referenceAssets.length}.png` };
  await writeJson(path.join(taskDir(root, guided.id), 'references/anchor-approved.json'), { ...guided.guidedFrom, sourceIndex: trial.trialFor.sourceIndex });
  await writeTask(root, guided);
  parent.anchorApprovals = [...(parent.anchorApprovals ?? []), { operationId: action.operationId, trialId: trial.id, taskId: guided.id }];
  await writeTask(root, parent);
  return { task: guided, enqueued: true };
}

async function copySnapshots(root: string, parent: Task, child: Task) {
  const from = taskDir(root, parent.id), to = taskDir(root, child.id);
  await fs.copyFile(path.join(from, 'input.gif'), path.join(to, 'input.gif'));
  for (const [i] of parent.referenceAssets.entries()) await fs.copyFile(path.join(from, 'references', `reference-${i + 1}.png`), path.join(to, 'references', `reference-${i + 1}.png`));
  if (parent.settings.smartPreset) await fs.copyFile(path.join(from, 'motion-analysis.json'), path.join(to, 'frozen-motion-analysis.json'));
}

export async function approvedFrame(root: string, task: Task) {
  if (task.settings.anchorSourceFrame === undefined) return undefined;
  const dir = taskDir(root, task.id);
  const approval = z.object({ imageFile: z.string(), imageSha256: z.string(), sourceIndex: z.number().int().nonnegative() }).parse(JSON.parse(await fs.readFile(path.join(dir, 'references/anchor-approved.json'), 'utf8')));
  const expectedFile = `references/reference-${task.referenceAssets.length}.png`;
  if (approval.imageFile !== expectedFile || approval.sourceIndex !== task.settings.anchorSourceFrame || sha256(await fs.readFile(path.join(dir, expectedFile))) !== approval.imageSha256) throw new Error('确认的基准图已变化。');
  const sampledIndex = task.sampling?.mapping.findIndex(f => f.sourceIndex === approval.sourceIndex) ?? -1;
  if (sampledIndex < 0) throw new Error('基准帧不在当前采样时间轴中。');
  let sourceIndex = sampledIndex;
  if (task.settings.dedupMode && task.settings.dedupMode !== 'off') {
    const mapping = z.object({ mapping: z.array(z.number().int().nonnegative()) }).parse(JSON.parse(await fs.readFile(path.join(dir, 'sampled/dedup/mapping.json'), 'utf8')));
    sourceIndex = mapping.mapping[sampledIndex]!;
    if (sourceIndex === undefined) throw new Error('基准帧去重映射不完整。');
  }
  return { sourceIndex, file: expectedFile, sha256: approval.imageSha256 };
}
