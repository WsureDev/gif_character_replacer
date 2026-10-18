import fs from 'node:fs/promises';
import path from 'node:path';
import { createOutputDirectory, writeJson } from './manifests.js';
import { readAiPlan } from './ai-plan.js';

interface Result {
  elapsedMs: number;
  reportedQuality: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number;
    input_tokens_details?: { image_tokens?: number; text_tokens?: number } } | null;
  validation: { passed: boolean; actualSize: string; nonOpaquePixels?: number };
  previews: { frames: number } | null;
}
async function optionalJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function buildAiReport(root: string, out: string) {
  const notes = await optionalJson<Record<string, string>>(path.join(root, 'visual-review.json')) ?? {};
  const relative = (file: string) => path.relative(out, file).split(path.sep).map(encodeURIComponent).join('/');
  const entries = [];
  const failed = [];
  for (const name of (await fs.readdir(root)).filter(n => n.startsWith('edit-')).sort()) {
    const directory = path.join(root, name);
    const result = await optionalJson<Result>(path.join(directory, 'result.json'));
    if (!result) { failed.push({ name, status: await optionalJson(path.join(directory, 'status.json')) }); continue; }
    const request = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8')) as { size: string; quality: string; model: string };
    const plan = await readAiPlan(path.join(directory, 'inputs/plan.json'));
    const recoveredDirectory = path.join(root, name.replace(/^edit-/, 'recovered-'));
    const registration = await optionalJson<{ validation: { passed: boolean; nonOpaquePixels: number } }>(path.join(recoveredDirectory, 'registration.json'));
    const previewDirectory = result.previews ? directory : registration?.validation.passed ? recoveredDirectory : null;
    const warnings = [];
    if (request.size !== result.validation.actualSize) warnings.push(`请求 ${request.size}，实际 ${result.validation.actualSize}`);
    if (result.reportedQuality && request.quality !== result.reportedQuality) warnings.push(`请求 ${request.quality}，返回报告 ${result.reportedQuality}`);
    entries.push({ id: name, source: plan.source.name, frameCount: plan.frames.length,
      sourceRange: [plan.frames[0]!.sourceIndex, plan.frames.at(-1)!.sourceIndex],
      requestedSize: request.size, actualSize: result.validation.actualSize,
      requestedQuality: request.quality, reportedQuality: result.reportedQuality,
      grid: `${plan.layout.columns}×${plan.layout.rows}`, cellSize: `${plan.layout.cells[0]!.width}×${plan.layout.cells[0]!.height}`,
      elapsedMs: result.elapsedMs, usage: result.usage,
      billing: { basis: 'per-output-image', outputImages: 1, frameCapacity: plan.frames.length,
        imageUnitsPerGeneratedFrame: 1 / plan.frames.length,
        imagesFor25FramesBeforeRetries: Math.ceil(25 / plan.frames.length),
        unitPrice: null, note: 'Actual cost = image count × provider price per image. Usable-frame cost needs visual acceptance.' },
      strictValidation: result.validation.passed, recovered: !!registration?.validation.passed,
      nonOpaquePixels: result.validation.nonOpaquePixels ?? registration?.validation.nonOpaquePixels ?? null,
      warnings, notes: notes[name] ?? '视觉效果待评审。',
      delays: plan.frames.map(f => f.delayMs),
      sourceFrames: plan.frames.map(f => relative(path.join(directory, 'inputs', f.file))),
      editedFrames: previewDirectory ? plan.frames.map((_, i) => relative(path.join(previewDirectory, 'frames', `frame-${String(i).padStart(4, '0')}.png`))) : [],
      reference: relative(path.join(directory, 'inputs', plan.references[0]!.file)),
      sourceSheet: relative(path.join(directory, 'inputs', plan.sheet.file)),
      editedSheet: relative(path.join(directory, 'edited-sheet.png')),
      gif: previewDirectory ? relative(path.join(previewDirectory, 'edited-preview.gif')) : null,
      prompt: relative(path.join(directory, 'inputs', plan.prompt.file)),
    });
  }
  await createOutputDirectory(out);
  const summary = { experiments: entries.length, generatedFrames: entries.reduce((n, e) => n + e.frameCount, 0),
    outputImages: entries.length, billingBasis: 'per-output-image',
    costNote: '按输出图片张数计费。每张单价记为 P，每版成本为 P；token 仅保留作诊断，不用于费用估算。可用帧成本仍需视觉验收。', failed, entries };
  await writeJson(path.join(out, 'summary.json'), summary);
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const cards = entries.map((e, i) => `<section id="case-${i}"><h2>${escape(e.id)} · ${escape(e.source)}</h2><p>${e.frameCount} 帧（原帧 ${e.sourceRange.join('–')}） · ${e.grid} · 输入每格 ${e.cellSize} · ${(e.elapsedMs / 1000).toFixed(1)} 秒</p><p>每张 ${e.frameCount} 帧 · 每生成帧 P/${e.frameCount} · 处理 25 帧理论需 ${e.billing.imagesFor25FramesBeforeRetries} 张（不含重试）</p>${e.warnings.map(w => `<p class="warn">${escape(w)}</p>`).join('')}<p>${escape(e.notes)}</p><div class="compare"><figure><figcaption>原始帧</figcaption><img class="source" src="${e.sourceFrames[0]}"></figure><figure><figcaption>替换后 ${e.recovered ? '（核对边界后恢复）' : ''}</figcaption>${e.editedFrames.length ? `<img class="edited" src="${e.editedFrames[0]}">` : '<p>几何检查未通过，暂不切帧。</p>'}</figure><figure class="reference"><figcaption>角色参考</figcaption><img src="${e.reference}"></figure></div>${e.editedFrames.length ? `<div class="controls"><button class="play">播放</button><button class="next">下一帧</button><input class="frame" type="range" min="0" max="${e.frameCount - 1}" value="0"><span class="counter">1 / ${e.frameCount}</span><select class="speed"><option value="1">原速</option><option value="0.5">0.5 倍</option><option value="0.25">0.25 倍</option></select></div>` : ''}<p><a href="${e.sourceSheet}">输入拼版</a> · <a href="${e.editedSheet}">原始返回图</a> · <a href="${e.prompt}">提示词</a>${e.gif ? ` · <a href="${e.gif}">GIF 片段</a>` : ''}</p></section>`).join('\n');
  const data = JSON.stringify(entries).replace(/</g, '\\u003c');
  await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GIF 换角实验</title><style>body{font:16px system-ui;background:#f1f3f5;color:#20242a;margin:24px auto;max-width:1200px;padding:0 18px}section{background:white;border:1px solid #dfe4ea;padding:20px;border-radius:12px;margin:22px 0}h1{font-size:28px}h2{font-size:20px}p{line-height:1.6}.warn{color:#964600;background:#fff3dc;padding:8px}.compare{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}figure{margin:0;flex:1;min-width:220px}figcaption{margin-bottom:8px}img{display:block;max-width:100%;max-height:430px;object-fit:contain;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/20px 20px}.reference{flex:0 0 150px;min-width:120px}.reference img{max-height:250px}.controls{display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}button,select{font:inherit;padding:6px 12px}.frame{min-width:160px;flex:1}a{color:#1557a6}</style><h1>GIF 角色替换 · 拼版实验</h1><p>${entries.length} 次编辑，${summary.generatedFrames} 个测试帧。原始帧与替换后帧使用同一时间轴，可暂停逐帧检查。这里展示的是片段实验，尚未完成整段 GIF 换角或跨批一致性验收。</p><p>使用各实验记录的输入帧与参考图。所有结果都保留原始返回图；尺寸和质量差异见各卡片。</p><p><a href="summary.json">参数、用量与汇总 JSON</a> · ${summary.costNote}</p>${cards}<script>const entries=${data};for(const [i,e] of entries.entries()){if(!e.editedFrames.length)continue;const root=document.getElementById('case-'+i),s=root.querySelector('.source'),d=root.querySelector('.edited'),slider=root.querySelector('.frame'),counter=root.querySelector('.counter'),play=root.querySelector('.play'),speed=root.querySelector('.speed');let current=0,playing=false,elapsed=0,last=performance.now();const durations=e.delays.map(n=>Math.max(10,n)),total=durations.reduce((a,b)=>a+b,0);for(const url of [...e.sourceFrames,...e.editedFrames]){const image=new Image();image.src=url;}function show(n){current=n;s.src=e.sourceFrames[n];d.src=e.editedFrames[n];slider.value=n;counter.textContent=(n+1)+' / '+e.frameCount;}function select(n){playing=false;play.textContent='播放';elapsed=durations.slice(0,n).reduce((a,b)=>a+b,0);show(n);}slider.oninput=()=>select(Number(slider.value));root.querySelector('.next').onclick=()=>select((current+1)%e.frameCount);play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放';last=performance.now();};function tick(now){if(playing){elapsed=(elapsed+(now-last)*Number(speed.value))%total;let t=elapsed,n=0;while(n<durations.length-1&&t>=durations[n]){t-=durations[n++];}if(n!==current)show(n);}last=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);}</script></html>`, { flag: 'wx' });
  return { experiments: entries.length, generatedFrames: summary.generatedFrames, outputImages: summary.outputImages,
    failed: failed.length, report: path.join(out, 'index.html') };
}
