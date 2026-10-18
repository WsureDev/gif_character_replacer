import { initProviders, providerPayload } from './providers.js';

interface SamplingOptions { resolution: { minLongEdge: number; maxLongEdge: number; presets: { longEdge: number; scale: number; width: number; height: number }[] };
  pixelAspect?: { ratio: number; aspectByte: number; rasterWidth: number; rasterHeight: number; width: number; height: number; corrected: boolean };
  frames: { min: number; max: number; presets: number[] }; fps: { min: number; max: number; presets: { value: number; frameBudget: number }[] };
  variableFrameTiming: boolean; canReduceFrames: boolean }
interface Asset { id: string; kind: 'gif' | 'reference'; name: string; file: string; width: number; height: number; frames?: number; durationMs?: number; samplingOptions?: SamplingOptions }
interface MotionPreset { id: string; label: string; frames: number; averageFps: number; reduction: number; busiestWindowFps: number }
interface MotionState { status: string; message: string; completedPairs?: number; totalPairs?: number; error?: string;
  analysis?: { frames: number; durationMs: number; adjacentPairsEvaluated: number; elapsedMs: number; recommendedId: string;
    windows: { startMs: number; endMs: number; motion: number }[]; presets: MotionPreset[] } }
interface Settings { scale: number; maxFps: number; frameCount?: number; smartPreset?: string; dedupMode?: string; dedupSimilarity?: number; anchorMode?: string; outputSize: string; minWidth: number; minHeight: number; maxWidth: number; maxHeight: number;
  maxFramesPerSheet: number; gutter: number; margin: number; subject: string; characterNotes: string; extraPrompt: string }
interface Task { id: string; name: string; status: string; createdAt: string; updatedAt: string; submittedAt?: string; settings: Settings; gifAsset: string; referenceAssets: string[];
  error?: string; draftHash?: string; provider: { model: string; quality: string } | null;
  progress: { message: string; completed: number; total: number };
  sampling?: { original: { width: number; height: number; frames: number; averageFps: number; durationMs: number };
    sampled: { width: number; height: number; frames: number; averageFps: number; durationMs: number } };
  sheets?: { index: number; directory: string; startFrame: number; frames: number; columns: number; rows: number; width: number; height: number; cellWidth: number; cellHeight: number; status: string;
    outputFile?: string; canRecover?: boolean; hasAttempt?: boolean; uncertain?: boolean; outputIsPrevious?: boolean; error?: string;
    failureStage?: string; generationCount?: number; processingAttempts?: number; httpStatus?: number; elapsedMs?: number; actualSize?: string }[];
  resumeInfo?: { existingImages: number; newImages: number; manualGenerationRequired: number; completed: number };
  anchorPreviews?: { id: string; frameIndex: number; status: string; error?: string; imageFile?: string; imageSha256?: string }[];
  anchorApprovals?: { taskId: string; trialId: string }[];
  trialFor?: { taskId: string; frameIndex: number };
  guidedFrom?: { taskId: string; trialId: string; imageFile: string };
  dedup?: { sourceFrames: number; uniqueFrames: number; reusedFrames: number; exactReuses: number; similarity: number; recommendedSimilarity: number; baselineSheets: number; sheets: number; maxError: number; meanError: number; elapsedMs: number;
    examples: { frame: number; representative: number; similarity: number }[];
    candidates: { similarity: number; uniqueFrames: number; sheets: number; maxError: number; meanError: number }[] };
  result?: { file: string; bytes: number; width: number; height: number; frames: number; durationMs: number } }
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = el<HTMLFormElement>('config-form');
const review = el('review'), initialReview = review.innerHTML;
const labels: Record<string, string> = { preparing: '准备中', draft: '草稿', queued: '排队中', running: '处理中', waiting: '待继续', completed: '已完成', failed: '失败', interrupted: '已中断' };
let gif: Asset | null = null, references: Asset[] = [], active: Task | null = null, dirty = false, busy = 0, pollBusy = false;
let configured = false, renderVersion = '';
let selectionVersion = 0, gifSelection = 0;
let motionState: MotionState | null = null, motionPending = false;
let queueSaving = false;
const anchorSelections = new Map<string, number>();
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const assetUrl = (a: Asset) => `/files/assets/${a.id}/${a.file}`;
const fileUrl = (t: Task, file: string) => `/files/tasks/${t.id}/${file}`;
const seconds = (n: number) => `${(n / 1000).toFixed(2).replace(/0$/, '')} 秒`;
const fps = (n: number) => Number(n.toFixed(2)).toString();

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
const post = <T>(url: string, data: unknown) => {
  const taskRequest = url === '/api/tasks' || /^\/api\/tasks\/[^/]+\/(submit|actions|anchor)$/.test(url);
  const selection = taskRequest ? providerPayload() : undefined;
  const payload = selection ? { ...(data as object), provider: selection } : data;
  return api<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
};
interface QueueState { limit: number; running: number; pending: number; queuedTasks?: number }
function displayQueue(q: QueueState) {
  const input = el<HTMLInputElement>('queue-limit');
  if (document.activeElement !== input && !queueSaving) input.value = String(q.limit);
  el('queue-status').textContent = `运行 ${q.running}/${q.limit} · 排队 ${q.pending}${q.queuedTasks ? ` · 等待任务 ${q.queuedTasks}` : ''}`;
  el('queue-status').title = '范围 1–120；降低并发不会中断已发出的请求。';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-concurrency]')) b.classList.toggle('selected', Number(b.dataset.concurrency) === q.limit);
}
async function refreshQueue() { displayQueue(await api<QueueState>('/api/queue')); }
async function saveQueue(limit: number) {
  if (queueSaving || !Number.isInteger(limit) || limit < 1 || limit > 120) return;
  queueSaving = true; el<HTMLButtonElement>('queue-save').disabled = true;
  try { const q = await post<QueueState>('/api/queue', { limit }); queueSaving = false; el<HTMLInputElement>('queue-limit').value = String(q.limit); displayQueue(q); }
  catch (e) { fail(e); } finally { queueSaving = false; el<HTMLButtonElement>('queue-save').disabled = false; }
}
el('queue-save').onclick = () => { const input = el<HTMLInputElement>('queue-limit'); if (input.reportValidity()) void saveQueue(Number(input.value)); };
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-concurrency]')) b.onclick = () => void saveQueue(Number(b.dataset.concurrency));
function operationId() {
  // getRandomValues also works on the user's plain-HTTP LAN origin.
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function notice(message = '') { el('notice').hidden = !message; el('notice').textContent = message; }
function fail(error: unknown) { notice(error instanceof Error ? error.message : String(error)); }
function field(name: string) { return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; }
function settings(): Settings {
  const byFrames = field('samplingMode').value === 'frames';
  const smart = field('samplingMode').value === 'smart';
  return { scale: Number(field('scale').value) / 100, maxFps: byFrames || smart ? 0 : Number(field('maxFps').value),
    anchorMode: field('anchorMode').value, dedupMode: field('dedupMode').value, ...(field('dedupMode').value === 'custom' ? { dedupSimilarity: Number(field('dedupSimilarity').value) } : {}),
    ...(byFrames ? { frameCount: Number(field('frameCount').value) } : {}), ...(smart ? { smartPreset: field('smartPreset').value } : {}), outputSize: field('outputSize').value,
    minWidth: Number(field('minWidth').value), minHeight: Number(field('minHeight').value), maxWidth: Number(field('maxWidth').value), maxHeight: Number(field('maxHeight').value),
    maxFramesPerSheet: Number(field('maxFramesPerSheet').value), gutter: Number(field('gutter').value), margin: Number(field('margin').value),
    subject: field('subject').value, characterNotes: field('characterNotes').value, extraPrompt: field('extraPrompt').value };
}
function setDirty() { dirty = true; updateSampling(); updateControls(); renderMotion(); }
function renderMotion() {
  const panel = el('motion-recommendations'), analysis = motionState?.analysis;
  el<HTMLOptionElement>('smart-mode-option').disabled = !analysis;
  if (!gif) { panel.innerHTML = '<p class="helper">选择 GIF 后会分析完整时间轴，推荐抽帧档位。</p>'; return; }
  if (!analysis) {
    panel.innerHTML = `<strong>本地抽帧推荐</strong><p class="helper">${escape(motionState?.message ?? '准备分析完整时间轴…')}${motionState?.totalPairs ? ` · ${motionState.completedPairs ?? 0}/${motionState.totalPairs} 对` : ''}</p>`; return;
  }
  const max = Math.max(0.001, ...analysis.windows.map(w => w.motion)), bars = analysis.windows.map((w, i) => {
    const h = Math.max(1, w.motion / max * 36); return `<rect x="${i * 240 / analysis.windows.length}" y="${40 - h}" width="${Math.max(1, 240 / analysis.windows.length - 1)}" height="${h}" fill="#6a78dd"><title>${seconds(w.startMs)}–${seconds(w.endMs)}</title></rect>`;
  }).join('');
  panel.innerHTML = `<strong>完整时间轴 · 抽帧推荐</strong><p class="helper">已比较 ${analysis.adjacentPairsEvaluated} 对相邻帧 · ${(analysis.elapsedMs / 1000).toFixed(2)} 秒</p><svg viewBox="0 0 240 42" role="img" aria-label="整个动画时间轴的变化密度">${bars}</svg><div class="motion-axis"><span>0 秒</span><span>${seconds(analysis.durationMs)}</span></div><p class="helper">静止段少留帧，动作段密集保留；下方平均 FPS 不会被统一套到整段动画。</p><div class="motion-presets">${analysis.presets.map(p => `<button type="button" class="motion-choice ${field('samplingMode').value === 'smart' && field('smartPreset').value === p.id ? 'selected' : ''}" data-motion="${p.id}"><span>${escape(p.label)}${p.id === analysis.recommendedId ? ' · 推荐' : ''}</span><b>${p.frames} / ${analysis.frames} 帧</b><small>减少 ${(p.reduction * 100).toFixed(0)}% · 平均 ${fps(p.averageFps)} FPS<br>最密片段约 ${fps(p.busiestWindowFps)} FPS</small></button>`).join('')}</div>`;
}
async function pollMotion() {
  if (!gif || motionPending || ['ready', 'failed'].includes(motionState?.status ?? '')) return;
  const id = gif.id; motionPending = true;
  try {
    const state = await api<MotionState | null>(`/api/assets/${id}/analysis`);
    if (gif?.id === id) { motionState = state; renderMotion(); updateSampling(); updateControls(); }
  } catch (error) { if (gif?.id === id) { motionState = { status: 'failed', message: '分析暂不可用，可手动采样', error: String(error) }; renderMotion(); } }
  finally { motionPending = false; }
}
function configureSampling() {
  motionState = null; field('smartPreset').value = ''; renderMotion();
  const options = gif?.samplingOptions;
  el<HTMLFieldSetElement>('sampling-fields').disabled = !options;
  field('maxFramesPerSheet').disabled = !options;
  if (!options) {
    for (const id of ['resolution-preset', 'frame-preset', 'fps-preset']) el<HTMLSelectElement>(id).replaceChildren(new Option('等待 GIF 信息…', ''));
    el('scale-value').textContent = '—';
    el('sampling-hint').textContent = '上传 GIF 后，自动识别并填充分辨率档位、帧数与帧率范围。';
    for (const id of ['sample-size', 'frame-range', 'fps-range', 'sampling-summary']) el(id).textContent = '';
    return;
  }
  const resolution = el<HTMLSelectElement>('resolution-preset');
  resolution.replaceChildren(...options.resolution.presets.map((r, i) => new Option(`${r.width}×${r.height} · ${i === 0 ? '原尺寸' : fps(r.scale * 100) + '%'}`, String(r.scale))), new Option('自定义（调整下方长边）', ''));
  for (const id of ['resolution-edge', 'long-edge']) {
    el<HTMLInputElement>(id).min = String(options.resolution.minLongEdge); el<HTMLInputElement>(id).max = String(options.resolution.maxLongEdge);
  }
  for (const id of ['frame-count', 'frame-slider']) {
    el<HTMLInputElement>(id).min = String(options.frames.min); el<HTMLInputElement>(id).max = String(options.frames.max);
  }
  el<HTMLSelectElement>('frame-preset').replaceChildren(...options.frames.presets.map(n => new Option(`${n} 帧${n === options.frames.max ? ' · 全部原帧' : gif?.durationMs ? ' · 平均 ' + fps(n * 1000 / gif.durationMs) + ' FPS' : ''}`, String(n))), new Option('自定义帧数', ''));
  el<HTMLSelectElement>('fps-preset').replaceChildren(...options.fps.presets.map(p => new Option(`${fps(p.value)} FPS · 最多 ${p.frameBudget} 帧`, String(p.value))), new Option('自定义帧率', ''));
  el<HTMLInputElement>('max-fps').min = String(options.fps.min); el<HTMLInputElement>('max-fps').max = String(options.fps.max);
  field('scale').value = '100'; field('frameCount').value = String(options.frames.max);
  field('maxFps').value = String(options.fps.max); field('samplingMode').value = 'frames'; field('maxFramesPerSheet').value = '0';
  el('sampling-hint').textContent = `已识别 ${gif!.width}×${gif!.height}、${options.frames.max} 帧、${seconds(gif!.durationMs ?? 0)}${options.variableFrameTiming ? ' · 变帧时长' : ''}。范围与档位均由此 GIF 生成。`;
  if (options.pixelAspect?.corrected) el('sampling-hint').textContent += ` 原始像素网格 ${options.pixelAspect.rasterWidth}×${options.pixelAspect.rasterHeight}，像素宽高比 ${fps(options.pixelAspect.ratio)}:1；已按显示比例转换为方形像素，避免变形。`;
  el('frame-range').textContent = `此 GIF 可选 ${options.frames.min}–${options.frames.max} 帧。`;
  el('fps-range').textContent = `此 GIF 可选 ${fps(options.fps.min)}–${fps(options.fps.max)} FPS，上限为原始平均帧率。`;
  updateSampling();
  void pollMotion();
}
function updateSampling() {
  const options = gif?.samplingOptions; if (!options || !gif) return;
  const scale = Number(field('scale').value) / 100;
  const edge = Math.round(options.resolution.maxLongEdge * scale);
  el('scale-value').textContent = `${fps(scale * 100)}%`;
  el<HTMLInputElement>('long-edge').value = String(edge);
  if (document.activeElement !== el('resolution-edge')) el<HTMLInputElement>('resolution-edge').value = String(edge);
  const resolution = options.resolution.presets.find(r => Math.abs(r.scale - scale) < 1e-12);
  el<HTMLSelectElement>('resolution-preset').value = resolution ? String(resolution.scale) : '';
  el('sample-size').textContent = `${gif.width}×${gif.height} → ${Math.max(1, Math.round(gif.width * scale))}×${Math.max(1, Math.round(gif.height * scale))}；长边可选 ${options.resolution.minLongEdge}–${options.resolution.maxLongEdge} px。`;
  const byFrames = field('samplingMode').value === 'frames', byFps = field('samplingMode').value === 'fps';
  field('samplingMode').disabled = !options.canReduceFrames;
  el('frame-settings').hidden = !byFrames; el('fps-settings').hidden = !byFps;
  for (const id of ['frame-count', 'frame-slider', 'frame-preset']) (el(id) as HTMLInputElement).disabled = !byFrames || !options.canReduceFrames;
  for (const id of ['max-fps', 'fps-preset']) (el(id) as HTMLInputElement).disabled = !byFps || !options.canReduceFrames;
  const n = Number(field('frameCount').value), rate = Number(field('maxFps').value);
  el<HTMLInputElement>('frame-slider').value = String(n);
  el<HTMLSelectElement>('frame-preset').value = options.frames.presets.includes(n) ? String(n) : '';
  const preset = options.fps.presets.find(p => Math.abs(p.value - rate) < 1e-12);
  el<HTMLSelectElement>('fps-preset').value = preset ? String(preset.value) : '';
  const smart = motionState?.analysis?.presets.find(p => p.id === field('smartPreset').value);
  const budget = byFrames ? n : byFps ? Math.max(1, Math.floor(rate * (gif.durationMs ?? 0) / 1000 + 1e-9)) : smart?.frames ?? active?.sampling?.sampled.frames ?? options.frames.max;
  const cap = Math.max(options.frames.min, Math.min(options.frames.max, budget || options.frames.max));
  (field('maxFramesPerSheet') as HTMLInputElement).max = String(cap);
  if (Number(field('maxFramesPerSheet').value) > cap) field('maxFramesPerSheet').value = '0';
  el('sheet-cap-range').textContent = `0 自动计算；手动上限可选 1–${cap} 帧。`;
  el('sampling-summary').textContent = options.canReduceFrames
    ? `${byFrames ? '保留' : byFps ? '预计最多' : '智能保留'} ${budget} / ${options.frames.max} 帧，总时长保持 ${seconds(gif.durationMs ?? 0)}。`
    : '此素材保留全部原帧与时序，可调整分辨率。';
}
function updateControls() {
  el('dedup-custom').hidden = field('dedupMode').value !== 'custom';
  field('dedupSimilarity').disabled = field('dedupMode').value !== 'custom';
  const prepare = el<HTMLButtonElement>('prepare');
  prepare.disabled = busy > 0 || !gif?.samplingOptions || !references.length || !!active?.guidedFrom || !!active?.trialFor || (field('samplingMode').value === 'smart' && motionState?.status !== 'ready');
  prepare.textContent = busy ? '正在处理素材…' : active?.guidedFrom || active?.trialFor ? '调整配置请返回选帧实验' : active && dirty ? '重新生成预览 · 保存新草稿' : '生成拼版预览 · 保存草稿';
  const submit = document.getElementById('submit') as HTMLButtonElement | null;
  const checked = (document.getElementById('reviewed') as HTMLInputElement | null)?.checked ?? false;
  if (submit) submit.disabled = dirty || busy > 0 || !configured || active?.status !== 'draft' || !checked;
  const warning = document.getElementById('dirty-warning');
  if (warning) warning.hidden = !dirty;
  for (const button of review.querySelectorAll<HTMLButtonElement>('[data-task-action]')) {
    button.disabled = busy > 0 || dirty || !active?.submittedAt || ['preparing', 'draft', 'queued', 'running'].includes(active.status)
      || button.dataset.allowed === 'no' || (button.dataset.generation === 'yes' && !configured);
  }
  const retryWarning = document.getElementById('retry-dirty'); if (retryWarning) retryWarning.hidden = !dirty;
  for (const button of review.querySelectorAll<HTMLButtonElement>('[data-anchor-action]')) button.disabled = busy > 0 || dirty || !configured || active?.status !== 'draft'
    || (button.dataset.anchorAction === 'trial' && !!active.anchorPreviews?.some(t => ['preparing', 'queued', 'running'].includes(t.status)));
}
function renderAssets() {
  el('gif-info').textContent = gif ? `${gif.name}\n${gif.width}×${gif.height} · ${gif.frames} 帧 · ${seconds(gif.durationMs ?? 0)} · 平均 ${fps(gif.samplingOptions?.fps.max ?? 0)} FPS` : '尚未选择动画';
  el('references').innerHTML = references.map((a, i) => `<div class="ref"><img src="${assetUrl(a)}" alt="${escape(a.name)}"><button type="button" data-remove="${i}" aria-label="移除参考图 ${i + 1}">×</button></div>`).join('');
  updateSampling(); updateControls();
}
async function upload(kind: 'gif' | 'reference', file: File) {
  return api<Asset>(`/api/assets?kind=${kind}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
}
async function withBusy(fn: () => Promise<void>) {
  busy++; updateControls(); notice();
  try { await fn(); } catch (error) { fail(error); } finally { busy--; renderAssets(); }
}
el<HTMLInputElement>('gif-file').addEventListener('change', event => {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  const version = ++gifSelection;
  void withBusy(async () => { const uploaded = await upload('gif', file); if (version === gifSelection) { gif = uploaded; configureSampling(); setDirty(); } });
});
el<HTMLInputElement>('ref-file').addEventListener('change', event => {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  void withBusy(async () => {
    if (references.length + files.length > 15) throw new Error('最多上传 15 张角色参考图。');
    for (const file of files) references.push(await upload('reference', file));
    setDirty();
  });
});
for (const [id, kind] of [['gif-library', 'gif'], ['ref-library', 'reference']] as const) {
  el<HTMLSelectElement>(id).addEventListener('change', event => {
    const name = (event.target as HTMLSelectElement).value; if (!name) return;
    const version = kind === 'gif' ? ++gifSelection : 0;
    void withBusy(async () => {
      if (kind === 'reference' && references.length >= 15) throw new Error('最多 15 张参考图。');
      const asset = await post<Asset>('/api/assets/library', { kind, name });
      if (kind === 'gif') { if (version === gifSelection) { gif = asset; configureSampling(); } } else references.push(asset);
      (event.target as HTMLSelectElement).value = ''; setDirty();
    });
  });
}
el('references').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
  if (button) { references.splice(Number(button.dataset.remove), 1); setDirty(); renderAssets(); }
});
function samplingInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (gif?.samplingOptions) {
    if (['resolution-edge', 'long-edge'].includes(input.id) && input.value && input.validity.valid) field('scale').value = String(Number(input.value) * 100 / gif.samplingOptions.resolution.maxLongEdge);
    if (input.id === 'resolution-preset' && input.value) field('scale').value = String(Number(input.value) * 100);
    if (['frame-preset', 'frame-slider'].includes(input.id) && input.value) field('frameCount').value = input.value;
    if (input.id === 'fps-preset' && input.value) field('maxFps').value = input.value;
    if (input.id === 'sampling-mode' && input.value === 'smart' && !field('smartPreset').value) field('smartPreset').value = motionState?.analysis?.recommendedId ?? '';
  }
  setDirty();
}
form.addEventListener('input', samplingInput);
form.addEventListener('change', samplingInput);
el('motion-recommendations').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-motion]');
  if (button && motionState?.analysis?.presets.some(p => p.id === button.dataset.motion)) {
    field('smartPreset').value = button.dataset.motion!; field('samplingMode').value = 'smart'; setDirty();
  }
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!gif || !references.length || busy || !form.reportValidity()) return;
  const payload = { name: field('name').value, gifAsset: gif.id, referenceAssets: references.map(a => a.id), settings: settings() };
  void withBusy(async () => {
    const task = await post<Task>('/api/tasks', payload);
    const current = { name: field('name').value, gifAsset: gif?.id, referenceAssets: references.map(a => a.id), settings: settings() };
    active = task; dirty = JSON.stringify(current) !== JSON.stringify(payload); renderVersion = ''; localStorage.setItem('gif-lab-active', task.id);
    renderTask(task); await refreshTasks();
  });
});
function badge(status: string) { return `<span class="badge ${escape(status)}">${escape(labels[status] ?? status)}</span>`; }
function batchCard(task: Task, s: NonNullable<Task['sheets']>[number]) {
  const input = fileUrl(task, `plans/${s.directory}/input-sheet.png`), output = s.outputFile ? fileUrl(task, s.outputFile) : null;
  const statusText: Record<string, string> = { pending: '待生成', queued: '等待名额', requesting: '生图中', splitting: '切图中', done: '已完成',
    failed: s.failureStage === 'processing' ? '切图失败' : '生图失败' };
  if (s.status === 'failed' && s.uncertain) statusText.failed = '结果待确认';
  const color = s.status === 'done' ? 'completed' : ['requesting', 'splitting'].includes(s.status) ? 'running' : s.status;
  const action = (mode: string, label: string, generation: boolean) => `<button type="button" data-task-action="batch" data-index="${s.index}" data-mode="${mode}" data-generation="${generation ? 'yes' : 'no'}" class="batch-action" disabled>${label}</button>`;
  const buttons = task.submittedAt ? `${s.canRecover ? action('recover', s.status === 'failed' ? '重试切图 · 不生图' : '重新切图 · 不生图', false) : ''}${action('generate', s.canRecover ? '重新生图 · 新增 1 张' : s.hasAttempt ? '重试生图 · 1 张' : '生成这一版 · 1 张', true)}` : '';
  return `<article class="sheet" data-sheet="${s.index}"><div class="sheet-caption"><strong>第 ${s.index + 1} 版 · ${s.columns}×${s.rows} · ${s.frames} 帧</strong><span class="badge ${color}">${escape(statusText[s.status] ?? s.status)}</span></div>
  <div class="sheet-pair"><figure><figcaption>输入拼版 <span>${s.width}×${s.height}</span></figcaption><button type="button" class="sheet-button" data-image="${input}" data-title="第 ${s.index + 1} 版 · 输入拼版"><img src="${input}" loading="lazy" alt="第 ${s.index + 1} 版输入图"></button></figure>
  <figure><figcaption>${s.outputIsPrevious ? '上次返回图' : '接口返回图'} <span>${escape(s.actualSize?.replace('x', '×') ?? '')}</span></figcaption>${output ? `<button type="button" class="sheet-button" data-image="${output}" data-title="第 ${s.index + 1} 版 · 返回图"><img src="${output}" loading="lazy" alt="第 ${s.index + 1} 版返回图"></button>` : `<div class="output-placeholder">${s.status === 'requesting' ? '正在生成图片…' : s.hasAttempt ? '尚未取得返回图' : task.submittedAt ? '尚未发出请求' : '审核 Submit 后生成'}</div>`}</figure></div>
  <p>${task.dedup ? '代表帧编号' : '采样帧'} ${s.startFrame + 1}–${s.startFrame + s.frames} · 单格 ${s.cellWidth}×${s.cellHeight}${s.httpStatus ? ` · HTTP ${s.httpStatus}` : ''}${s.elapsedMs ? ` · ${(s.elapsedMs / 1000).toFixed(1)} 秒` : ''}${s.generationCount ? ` · 生成尝试 ${s.generationCount} 次` : ''}</p>
  ${s.error ? `<div class="batch-error">${escape(s.error)}</div>` : ''}${s.uncertain ? '<p class="unknown-warning">上次请求结果未确认；重新发送可能产生重复计费。</p>' : ''}<div class="batch-actions">${buttons}</div><details class="prompt-review" data-prompt-task="${task.id}" data-prompt-index="${s.index}"><summary>查看本版实际发送的完整提示词</summary><p class="helper prompt-version"></p><pre>展开后加载已保存的提示词快照…</pre></details></article>`;
}
function dedupPanel(task: Task) {
  const d = task.dedup; if (!d) return '';
  const image = (index: number) => fileUrl(task, `sampled/frame-${String(index).padStart(6, '0')}.png`);
  return `<section class="dedup-review"><h3>实验 · 相似帧复用</h3><p>${d.sourceFrames} 帧 → <strong>${d.uniqueFrames} 张代表帧</strong> · 复用 ${d.reusedFrames} 帧（其中与代表帧完全相同 ${d.exactReuses} 帧）<br>预计版图 <strong>${d.baselineSheets} → ${d.sheets} 张</strong> · ${d.baselineSheets > d.sheets ? `节省 ${d.baselineSheets - d.sheets} 次生图` : '本档位未减少版图费用'}</p><p class="helper">当前阈值 ${d.similarity}% · 自动建议 ${d.recommendedSimilarity}% · 最低实际匹配评分 ${(100 * (1 - d.maxError)).toFixed(3)}%。评分基于像素及局部差异，不代表语义识别准确率；大幅局部像素变化不复用。播放帧数、逐帧时长与循环沿用当前采样时间轴。</p>
    <div class="comparison"><figure><figcaption>去重前 · 采样动画</figcaption><div class="preview-box"><img src="${fileUrl(task, 'sampled/preview.gif')}" alt="去重前"></div></figure><figure><figcaption>代表帧复用后 · 本地模拟还原</figcaption><div class="preview-box"><img src="${fileUrl(task, 'sampled/dedup/preview/edited.gif')}" alt="去重还原预览"></div></figure></div>
    <details><summary>比较阈值与省版效果</summary><div class="dedup-table"><table><thead><tr><th>最低评分</th><th>代表帧</th><th>版图</th><th>选择</th></tr></thead><tbody>${d.candidates.map(c => `<tr><td>${c.similarity}%${c.similarity === d.recommendedSimilarity ? ' · 推荐' : ''}</td><td>${c.uniqueFrames}</td><td>${c.sheets}</td><td><button type="button" data-dedup-threshold="${c.similarity}" class="batch-action">使用</button></td></tr>`).join('')}</tbody></table></div><p class="helper">选择后需要重新生成草稿。自动建议在评分 ≥99%、平均误差 ≤0.3% 的候选中，选择达到最低版图数的最严格档位；建议基于整段素材的实测结果。</p></details>
    ${d.examples.length ? `<details><summary>检查复用帧 · 优先展示差异最大的 ${d.examples.length} 对</summary><div class="dedup-examples">${d.examples.map(e => `<div class="comparison"><figure><figcaption>第 ${e.frame + 1} 帧 · 被复用</figcaption><img src="${image(e.frame)}" loading="lazy" alt="被复用帧"></figure><figure><figcaption>代表帧 ${e.representative + 1} · ${e.similarity.toFixed(3)}%</figcaption><img src="${image(e.representative)}" loading="lazy" alt="代表帧"></figure></div>`).join('')}</div></details>` : ''}
    <p class="helper"><a href="${fileUrl(task, 'sampled/dedup/mapping.json')}" target="_blank">完整复用映射</a> · <a href="${fileUrl(task, 'sampled/dedup/report.json')}" target="_blank">算法评估报告</a> · 下方拼版仅含代表帧；同一代表帧的改图结果会被一致复用。</p></section>`;
}
function anchorPanel(task: Task) {
  if (task.guidedFrom) return `<section class="anchor-panel"><h3>共同基准图已确认</h3><img class="anchor-image" src="${fileUrl(task, task.guidedFrom.imageFile)}" alt="各版共同使用的确认效果图"><p>每版都会携带这张效果图，约束角色外观、配色、材质和画风，并保留各帧动作。所选帧在成品中复用确认结果；若启用去重，同组帧一并复用。下方审核 Submit 后才生成各版。</p><button type="button" class="text-button" data-open-task="${task.guidedFrom.taskId}">返回选帧实验</button></section>`;
  if (task.trialFor) return `<section class="anchor-panel"><h3>单帧试生成 · 第 ${task.trialFor.frameIndex + 1} 帧</h3><p>这次仅生成 1 张试效果，不会自动生成整段。失败时可使用下方重切或生图重试。</p><button type="button" class="text-button" data-open-task="${task.trialFor.taskId}">返回实验 · 预览并确认效果</button></section>`;
  if (task.settings.anchorMode !== 'frame' || !task.sampling) return '';
  const index = anchorSelections.get(task.id) ?? 0, count = task.sampling.sampled.frames;
  return `<section class="anchor-panel"><h3>第一步 · 选一帧试效果</h3><p>选择主体清楚、能代表整体画风的一帧。首次试生成额外计 1 张；不满意可以重新试，确认后再生成 ${task.sheets?.length ?? 0} 版。</p><div class="anchor-picker"><label for="anchor-frame">采样帧编号（1–${count}）</label><input id="anchor-frame" type="number" min="1" max="${count}" step="1" value="${index + 1}"><input id="anchor-slider" type="range" min="1" max="${count}" step="1" value="${index + 1}" aria-label="选择试生成帧"><img id="anchor-source" class="anchor-image" src="${fileUrl(task, `sampled/frame-${String(index).padStart(6, '0')}.png`)}" alt="选择的原始帧"></div><button type="button" class="primary" data-anchor-action="trial">试生成所选帧 · 1 张</button>${dirty ? '<p class="dirty-warning">配置已修改，请重新生成草稿后试生成。</p>' : ''}
    <div class="anchor-trials">${(task.anchorPreviews ?? []).map(t => `<article><div class="sheet-caption"><strong>第 ${t.frameIndex + 1} 帧试效果</strong>${badge(t.status)}</div><div class="comparison"><figure><figcaption>原帧</figcaption><img src="${fileUrl(task, `sampled/frame-${String(t.frameIndex).padStart(6, '0')}.png`)}" alt="试生成原帧"></figure><figure><figcaption>试生成结果</figcaption>${t.imageFile ? `<img src="/files/tasks/${t.id}/${t.imageFile}" alt="试生成效果">` : '<p class="helper">等待效果图；失败可打开任务查看返回图并重试。</p>'}</figure></div>${t.error ? `<p class="batch-error">${escape(t.error)}</p>` : ''}<div class="batch-actions"><button type="button" class="text-button" data-open-task="${t.id}">打开试生成任务 / 重试</button>${t.imageFile ? `<button type="button" class="primary" data-anchor-action="approve" data-trial="${t.id}" data-image-hash="${t.imageSha256}">确认这张效果 · 生成后续草稿</button>` : ''}</div></article>`).join('')}</div>
    ${(task.anchorApprovals ?? []).map(a => `<button type="button" class="text-button" data-open-task="${a.taskId}">打开已确认基准的草稿</button>`).join('')}<p class="helper">确认只准备新草稿，不自动发送其余生图请求。同一基准可帮助衔接，但跨版动作与细节仍需检查。</p></section>`;
}
function renderTask(task: Task) {
  const version = JSON.stringify(task);
  if (renderVersion === version) { updateControls(); return; }
  renderVersion = version; active = task;
  const sample = task.sampling, sheets = task.sheets ?? [], original = sample?.original, sampled = sample?.sampled;
  const count = sheets.length;
  const done = task.progress.completed, total = task.progress.total;
  const metrics = original && sampled ? `<div class="metrics"><div class="metric"><small>采样分辨率</small><strong>${sampled.width}×${sampled.height}</strong><p>原始 ${original.width}×${original.height} · ${Math.round(task.settings.scale * 100)}%</p></div><div class="metric"><small>保留帧数</small><strong>${sampled.frames} <span class="muted">/ ${original.frames}</span></strong><p>${fps(original.averageFps)} → ${fps(sampled.averageFps)} FPS</p></div><div class="metric"><small>播放时长</small><strong>${seconds(sampled.durationMs)}</strong><p>原时长 ${seconds(original.durationMs)}</p></div><div class="metric cost"><small>预计编辑图片</small><strong>${count || '…'} 张</strong><p>每张版图一次请求</p></div></div>` : '';
  const previews = sampled ? `<div class="comparison"><figure><figcaption>原始 GIF</figcaption><div class="preview-box"><img src="${fileUrl(task, 'input.gif')}" alt="原始动画"></div></figure><figure><figcaption>采样预览 · ${fps(sampled.averageFps)} FPS</figcaption><div class="preview-box"><img src="${fileUrl(task, 'sampled/preview.gif')}" alt="采样后的动画"></div></figure></div>` : '';
  const cards = anchorPanel(task) + dedupPanel(task) + sheets.map(s => batchCard(task, s)).join('');
  const pending = ['preparing', 'queued', 'running'].includes(task.status);
  const progress = pending ? `<div class="status-message">${escape(task.progress.message)}${total ? `<div class="progress-track"><div style="width:${done / total * 100}%"></div></div>` : ''}</div>` : '';
  const result = task.result ? `<section class="result"><div class="result-top"><h3>${task.status === 'completed' ? task.trialFor ? '单帧试效果已生成' : '完整 GIF 已生成' : '上次完成的 GIF'}</h3><a href="${fileUrl(task, task.result.file)}" download="${escape(task.name)}-edited.gif">下载 GIF ↗</a></div><p>${task.result.width}×${task.result.height} · ${task.result.frames} 帧 · ${seconds(task.result.durationMs)} · ${(task.result.bytes / 1024 / 1024).toFixed(2)} MiB</p><img src="${fileUrl(task, task.result.file)}" alt="替换角色后的完整 GIF"></section>` : '';
  const submit = task.status === 'draft' && task.settings.anchorMode !== 'frame' ? `<div class="submit-bar"><div id="dirty-warning" class="dirty-warning" ${dirty ? '' : 'hidden'}>配置已修改。请重新生成拼版草稿，再审核提交。</div>${!configured ? '<p class="error-box">请在顶部选择自定义 provider，或用 secret 解锁服务端列表。若首次提交与草稿 provider 不一致，请重新生成草稿。</p>' : ''}<label class="review-check"><input type="checkbox" id="reviewed">我已查看此草稿的采样效果与全部 ${count} 张拼版</label><div class="submit-actions"><p>Submit 后将生成 ${count} 张图片。<br>按图片张数计费，任务不会自动重试。</p><button id="submit" type="button" class="primary" disabled>Submit · 提交 ${count} 张</button></div></div>` : '';
  const resume = task.resumeInfo;
  const continuation = task.submittedAt && ['failed', 'interrupted', 'waiting'].includes(task.status) && resume
    ? `<div class="continue-bar"><p>已有 ${resume.existingImages} 张返回图，可直接复用；尚未发送 ${resume.newImages} 张。${resume.manualGenerationRequired ? `另有 ${resume.manualGenerationRequired} 版需在下方手动重试生图。` : ''} 新请求使用当前接口配置。</p><button type="button" class="primary" data-task-action="continue" data-generation="${resume.newImages ? 'yes' : 'no'}" data-allowed="${resume.manualGenerationRequired ? 'no' : 'yes'}" disabled>继续剩余任务${resume.newImages ? ` · 生成 ${resume.newImages} 张` : ' · 不重新生图'}</button></div>` : '';
  review.innerHTML = `<div class="review-heading"><div><span class="eyebrow">02 / DRAFT REVIEW</span><h2>${escape(task.name)}</h2><p class="helper">${escape(task.provider?.model ?? '接口待配置')} · ${escape(task.provider?.quality ?? '')}</p></div>${badge(task.status)}</div>${progress}${task.error ? `<div class="error-box">${escape(task.error)}</div><p class="helper">${task.resumeInfo?.existingImages ? "已有返回图可以在对应版查看或重切；没有返回图的版请先核对供应商结果。" : "尚未取得可处理的返回图。上游超时不代表未生成，请先核对供应商结果，避免重复计费。"}</p>` : ''}${continuation}${result}${metrics}${previews}${task.submittedAt ? '<p id="retry-dirty" class="dirty-warning" hidden>配置已修改。重试沿用原任务的已审核输入；请重新打开此任务，或生成新草稿。</p>' : ''}${count ? `<div class="section-title"><h3>生图任务 · ${count} 版</h3><span>输入／返回图均可点击放大</span></div><div class="sheets">${cards}</div>` : ''}${submit}${['completed', 'waiting', 'failed', 'interrupted'].includes(task.status) ? '<div class="submit-bar"><button id="clone-task" type="button" class="clone-button">沿用配置 · 调整后创建新草稿</button></div>' : ''}`;
  document.getElementById('reviewed')?.addEventListener('change', updateControls);
  for (const button of review.querySelectorAll<HTMLButtonElement>('[data-dedup-threshold]')) button.onclick = () => {
    field('dedupMode').value = 'custom'; field('dedupSimilarity').value = button.dataset.dedupThreshold!;
    setDirty(); notice('已选择去重阈值，请重新生成拼版预览，审核新的代表帧与还原效果。');
  };
  document.getElementById('submit')?.addEventListener('click', () => {
    if (!active || dirty || busy || active.status !== 'draft' || !el<HTMLInputElement>('reviewed').checked) return;
    const id = active.id, hash = active.draftHash;
    void withBusy(async () => { const task = await post<Task>(`/api/tasks/${id}/submit`, { draftHash: hash }); renderTask(task); await refreshTasks(); });
  });
  document.getElementById('clone-task')?.addEventListener('click', () => {
    const parent = task.guidedFrom?.taskId ?? task.trialFor?.taskId;
    if (parent) { void loadTask(parent).then(() => notice('已返回原实验；在这里调整参数并生成新草稿。')).catch(fail); return; }
    dirty = true; updateControls(); notice('配置已载入左侧；调整后点击“重新生成预览”保存为新草稿。'); form.scrollIntoView({ behavior: 'smooth' });
  });
  updateControls();
}
async function loadTask(id: string) {
  const version = ++selectionVersion;
  const task = await api<Task>(`/api/tasks/${id}`);
  const assets = await Promise.all([task.gifAsset, ...task.referenceAssets].map(id => api<Asset>(`/api/assets/${id}`)));
  if (version !== selectionVersion) return;
  gifSelection++; gif = assets[0]!; references = assets.slice(1); dirty = false; active = task;
  configureSampling();
  field('name').value = task.name;
  field('anchorMode').value = 'off'; field('dedupMode').value = 'off'; field('dedupSimilarity').value = '99.5';
  for (const [name, value] of Object.entries(task.settings)) if (field(name)) field(name).value = String(name === 'scale' ? Number(value) * 100 : value);
  field('samplingMode').value = task.settings.smartPreset ? 'smart' : task.settings.frameCount !== undefined || !task.settings.maxFps ? 'frames' : 'fps';
  field('frameCount').value = String(task.settings.frameCount ?? gif!.frames);
  if (!task.settings.maxFps) field('maxFps').value = String(gif!.samplingOptions?.fps.max ?? 0);
  renderVersion = ''; renderAssets(); renderTask(task); localStorage.setItem('gif-lab-active', id);
  await refreshTasks();
}
async function refreshTasks() {
  const tasks = await api<Task[]>('/api/tasks');
  el('task-list').innerHTML = tasks.length ? tasks.map(t => `<button type="button" class="task-item ${active?.id === t.id ? 'active' : ''}" data-task="${t.id}"><strong>${escape(t.name)}</strong><span class="task-meta">${badge(t.status)}<span>${t.sheets?.length ? t.sheets.length + ' 张' : new Date(t.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></span></button>`).join('') : '<p class="muted">暂无任务，先创建一个草稿。</p>';
  if (active) { const latest = tasks.find(t => t.id === active!.id); if (latest) renderTask(latest); }
}
el('task-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task]'); if (button) void loadTask(button.dataset.task!).catch(fail); });
el('refresh').onclick = () => void refreshTasks().catch(fail);
el('new-task').onclick = () => {
  selectionVersion++; gifSelection++; active = null; dirty = false; renderVersion = ''; gif = null; references = []; form.reset(); configureSampling();
  localStorage.removeItem('gif-lab-active'); review.innerHTML = initialReview; renderAssets(); notice(); void refreshTasks().catch(fail);
};
const dialog = el<HTMLDialogElement>('image-dialog');
review.addEventListener('toggle', event => {
  const details = event.target as HTMLDetailsElement;
  if (!details.matches('.prompt-review') || !details.open || details.dataset.loaded) return;
  details.dataset.loaded = 'loading';
  void api<{ text: string; version: string }>(`/api/tasks/${details.dataset.promptTask}/prompts/${details.dataset.promptIndex}`).then(prompt => {
    details.querySelector('pre')!.textContent = prompt.text;
    details.querySelector('.prompt-version')!.textContent = `模板版本 ${prompt.version} · 此内容就是本版请求的提示词快照。修改配置后须新建草稿。`;
    details.dataset.loaded = 'yes';
  }).catch(error => { delete details.dataset.loaded; details.querySelector('pre')!.textContent = error instanceof Error ? error.message : String(error); });
}, true);
review.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (!active || !['anchor-frame', 'anchor-slider'].includes(input.id) || !input.validity.valid || !input.value) return;
  const index = Number(input.value) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= (active.sampling?.sampled.frames ?? 0)) return;
  anchorSelections.set(active.id, index);
  el<HTMLInputElement>('anchor-frame').value = String(index + 1); el<HTMLInputElement>('anchor-slider').value = String(index + 1);
  el<HTMLImageElement>('anchor-source').src = fileUrl(active, `sampled/frame-${String(index).padStart(6, '0')}.png`);
});
review.addEventListener('click', event => {
  const target = event.target as HTMLElement, open = target.closest<HTMLButtonElement>('[data-open-task]');
  if (open) { void loadTask(open.dataset.openTask!).catch(fail); return; }
  const button = target.closest<HTMLButtonElement>('[data-anchor-action]');
  if (!button || button.disabled || !active?.draftHash || busy || dirty) return;
  const id = active.id, action = { operationId: operationId(), draftHash: active.draftHash, kind: button.dataset.anchorAction,
    ...(button.dataset.anchorAction === 'trial' ? { frameIndex: anchorSelections.get(id) ?? 0 } : { trialId: button.dataset.trial, imageSha256: button.dataset.imageHash }) };
  void withBusy(async () => {
    const next = await post<Task>(`/api/tasks/${id}/anchor`, action);
    if (action.kind === 'approve') await loadTask(next.id);
    else { notice('已提交单帧试生成；整段仍等待你确认效果。'); await refreshTasks(); }
  });
});
review.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
  if (!button || button.disabled || !active?.draftHash || busy || dirty) return;
  const id = active.id;
  const action = { operationId: operationId(), draftHash: active.draftHash, kind: button.dataset.taskAction,
    ...(button.dataset.taskAction === 'batch' ? { sheetIndex: Number(button.dataset.index), mode: button.dataset.mode } : {}) };
  void withBusy(async () => {
    const task = await post<Task>(`/api/tasks/${id}/actions`, action);
    if (active?.id === id) renderTask(task);
    await refreshTasks(); await refreshQueue();
  });
});
review.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-image]'); if (!button) return;
  el<HTMLImageElement>('large-image').src = button.dataset.image!; el('image-title').textContent = button.dataset.title!;
  el<HTMLAnchorElement>('image-original').href = button.dataset.image!; dialog.showModal();
});
el('close-dialog').onclick = () => dialog.close();
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
async function init() {
  initProviders((ready, label) => {
    configured = ready; el('connection').classList.toggle('ready', ready);
    el('connection').textContent = ready ? `${label} · 已选择` : `${label} · 草稿仍可预览`;
    renderVersion = ''; if (active) renderTask(active); else updateControls();
  });
  const library = await api<{ gifs: string[]; references: string[] }>('/api/library');
  for (const [id, names] of [['gif-library', library.gifs], ['ref-library', library.references]] as const) {
    for (const name of names) el<HTMLSelectElement>(id).add(new Option(name, name));
  }
  const saved = localStorage.getItem('gif-lab-active');
  if (saved) { try { await loadTask(saved); } catch { localStorage.removeItem('gif-lab-active'); await refreshTasks(); } }
  else await refreshTasks();
  await refreshQueue();
  renderAssets();
}
setInterval(() => {
  void pollMotion();
  if (pollBusy || document.hidden) return;
  pollBusy = true;
  void Promise.all([refreshTasks(), refreshQueue()]).catch(fail).finally(() => { pollBusy = false; });
}, 2000);
void init().catch(fail);
export {};
