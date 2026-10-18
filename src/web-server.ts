import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { z } from 'zod';
import { inspectGif } from './gif.js';
import { samplingOptions, type SamplingOptions } from './sampling-options.js';
import { readAnalysisState, writeAnalysisState } from './motion-analysis.js';
import type { AiConfig } from './ai-config.js';
import { approveDraft, approveTaskAction } from './lab-jobs.js';
import { assetDir, providerIdentity, createTask, readAsset, readTask, taskDir, writeTask, type Asset } from './lab-store.js';
import { describeTask } from './batch-state.js';
import { ImageQueue, type ImageGate } from './image-queue.js';
import { approveAnchorAction } from './anchor.js';
import { readAiPlan } from './ai-plan.js';
import { sha256 } from './pixels.js';
import { listProviders, resolveProvider, splitProviderInput, ProviderAccessError } from './providers.js';

interface Options { dataDir: string; projectDir: string; envFile: string;
  job?: (mode: 'prepare' | 'execute', id: string, gate?: ImageGate, config?: AiConfig) => Promise<void>; analyze?: boolean }

async function body(req: IncomingMessage, limit = 128 * 1024) {
  const parts: Buffer[] = []; let size = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value as Uint8Array); size += chunk.length;
    if (size > limit) throw new Error(`上传超过 ${Math.round(limit / 1024 / 1024)} MiB 限制。`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
async function jsonBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json.');
  return JSON.parse((await body(req)).toString('utf8')) as unknown;
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function serveFile(res: ServerResponse, file: string, type: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Not a file.');
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size,
    'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export async function createLabServer(options: Options) {
  const { dataDir: root, projectDir, envFile } = options;
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  const queueSettings = path.join(root, 'queue-settings.json');
  let concurrency = 2;
  try { concurrency = z.object({ limit: z.number().int().min(1).max(120) }).parse(JSON.parse(await fs.readFile(queueSettings, 'utf8'))).limit; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const imageQueue = new ImageQueue(concurrency);
  const taskIds = async () => (await fs.readdir(path.join(root, 'tasks'))).filter(id => z.string().uuid().safeParse(id).success);
  for (const id of await taskIds()) {
    const task = await readTask(root, id);
    if (['preparing', 'queued', 'running'].includes(task.status)) {
      task.status = 'interrupted'; task.error = '服务曾中断。已保存素材与结果，未自动重新发送图片请求。';
      task.progress.message = '任务已中断'; await writeTask(root, task);
    }
  }
  const queues = { prepare: [] as string[], execute: [] as string[] };
  const active = { prepare: new Set<string>(), execute: new Set<string>() };
  const children = new Set<ChildProcess>();
  const submitting = new Set<string>();
  const jobConfigs = new Map<string, AiConfig | undefined>();
  let stopping = false;
  const analysisQueue: string[] = [], analyses = new Set<string>();
  let analysisActive = false;
  async function enqueueAnalysis(id: string) {
    if (options.analyze === false || analyses.has(id) || stopping) return;
    const directory = assetDir(root, id), state = await readAnalysisState(directory);
    if (state?.status === 'ready' || state?.status === 'failed' || analyses.has(id)) return;
    analyses.add(id); analysisQueue.push(id);
    await writeAnalysisState(directory, { status: 'queued', message: '等待完整时间轴分析' });
    void pumpAnalysis();
  }
  async function pumpAnalysis() {
    if (analysisActive || stopping) return;
    const id = analysisQueue.shift(); if (!id) return;
    analysisActive = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const file = new URL(import.meta.url.endsWith('.ts') ? './analysis-worker.ts' : './analysis-worker.js', import.meta.url);
        const child = fork(fileURLToPath(file), [assetDir(root, id)], { stdio: 'ignore' });
        children.add(child); child.once('error', reject);
        child.once('exit', code => { children.delete(child); if (code === 0) resolve(); else reject(new Error('分析进程中断')); });
      });
    } catch { if (!stopping) await writeAnalysisState(assetDir(root, id), { status: 'failed', message: '本地分析中断，仍可手动采样' }); }
    finally { analyses.delete(id); analysisActive = false; void pumpAnalysis(); }
  }
  function enqueue(mode: 'prepare' | 'execute', id: string, config?: AiConfig) {
    if (!queues[mode].includes(id)) { jobConfigs.set(`${mode}:${id}`, config); queues[mode].push(id); }
    pump(mode);
  }
  function pump(mode: 'prepare' | 'execute') {
    const capacity = mode === 'prepare' ? 1 : imageQueue.limit;
    while (!stopping && active[mode].size < capacity) {
      const index = queues[mode].findIndex(id => !active[mode].has(id));
      if (index < 0) return;
      const id = queues[mode].splice(index, 1)[0]!; active[mode].add(id); void launch(mode, id);
    }
  }
  async function launch(mode: 'prepare' | 'execute', id: string) {
    const owner = randomUUID();
    const config = jobConfigs.get(`${mode}:${id}`); jobConfigs.delete(`${mode}:${id}`);
    try {
      if (options.job) await options.job(mode, id, { acquire: (_task, sheet) => imageQueue.acquire(id, sheet, owner), cancelPending: () => imageQueue.cancelPending(id) }, config);
      else await new Promise<void>((resolve, reject) => {
        const worker = new URL(import.meta.url.endsWith('.ts') ? './lab-worker.ts' : './lab-worker.js', import.meta.url);
        const child = fork(fileURLToPath(worker), [mode, root, id, envFile], { stdio: 'ignore' });
        const releases = new Map<string, () => void>();
        children.add(child);
        child.on('message', (raw: unknown) => {
          const message = raw as { type?: string; taskId?: string; sheetIndex?: number; requestId?: string };
          if (message.type === 'image-acquire' && message.taskId === id && typeof message.requestId === 'string'
            && Number.isInteger(message.sheetIndex) && message.sheetIndex! >= 0) {
            const requestId = message.requestId;
            void imageQueue.acquire(id, message.sheetIndex!, owner).then(release => {
              if (!child.connected || stopping) { release(); return; }
              releases.set(requestId, release);
              child.send({ type: 'image-granted', requestId }, error => { if (error) { releases.delete(requestId); release(); } });
            }).catch(() => { if (child.connected) child.send({ type: 'image-cancelled', requestId }, () => undefined); });
          } else if (message.type === 'image-release' && message.requestId) {
            releases.get(message.requestId)?.(); releases.delete(message.requestId);
          } else if (message.type === 'image-cancel-pending' && message.taskId === id) imageQueue.cancelPending(id);
        });
        child.once('error', reject);
        child.once('exit', code => { children.delete(child); if (code === 0) resolve(); else reject(new Error('工作进程退出，未自动重试。')); });
        child.send({ type: 'job-config', config: config ?? null }, error => { if (error) reject(error); });
      });
      if (mode === 'prepare' && !stopping && !submitting.has(id)) {
        submitting.add(id);
        try {
          const task = await readTask(root, id);
          if (task.status === 'draft' && task.trialFor?.autoSubmit) {
            // The user explicitly requested exactly one trial image. Whole-animation drafts stay unsubmitted.
            if (!config) throw new Error('试生成的 provider 凭据已失效，请重新选择。');
            const approved = await approveDraft(root, id, task.draftHash!, config);
            if (approved.enqueued) enqueue('execute', id, config);
          }
        } finally { submitting.delete(id); }
      }
    } catch {
      const task = await readTask(root, id);
      if (!['completed', 'failed'].includes(task.status)) {
        task.status = 'interrupted'; task.error = '工作进程中断，现有结果已保留。不会自动重发图片请求。';
        task.progress.message = '任务中断'; await writeTask(root, task);
      }
    } finally { imageQueue.detachOwner(owner); active[mode].delete(id); pump(mode); }
  }
  async function saveAsset(kind: 'gif' | 'reference', name: string, bytes: Buffer) {
    const id = randomUUID(); let normalized = bytes;
    let width: number, height: number, frames: number | undefined, durationMs: number | undefined;
    let options: SamplingOptions | undefined;
    if (kind === 'gif') {
      const metadata = inspectGif(bytes);
      ({ width, height, frameCount: frames, durationMs } = metadata);
      options = samplingOptions(metadata);
      width = options.pixelAspect.width; height = options.pixelAspect.height;
    } else {
      const image = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 });
      const metadata = await image.metadata();
      if (!['png', 'jpeg', 'webp', 'avif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('参考图请使用单张 PNG、JPEG、WebP 或 AVIF。');
      normalized = await image.rotate().png().toBuffer();
      const output = await sharp(normalized).metadata(); width = output.width!; height = output.height!;
    }
    const asset: Asset = { id, kind, name: path.basename(name).slice(0, 120) || kind, file: kind === 'gif' ? 'source.gif' : 'reference.png',
      bytes: normalized.length, width, height, ...(frames !== undefined ? { frames, durationMs, samplingOptions: options } : {}) };
    const dir = assetDir(root, id); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, asset.file), normalized, { flag: 'wx' });
    await fs.writeFile(path.join(dir, 'asset.json'), JSON.stringify(asset), { flag: 'wx' });
    if (kind === 'gif') await enqueueAnalysis(id);
    return asset;
  }
  async function library(kind: 'gif' | 'reference') {
    const dir = path.join(projectDir, 'materials', kind === 'gif' ? 'gifs' : 'references');
    const pattern = kind === 'gif' ? /\.gif$/i : /\.(png|jpe?g|webp|avif)$/i;
    return (await fs.readdir(dir)).filter(n => pattern.test(n)).sort();
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : error instanceof Error ? error.message : '请求失败';
      send(res, error instanceof ProviderAccessError ? error.status : code === 'ENOENT' ? 404 : 400, { error: code === 'ENOENT' ? '文件或任务不存在。' : message });
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost'), pathname = decodeURIComponent(url.pathname);
    // LAN access is open. Browser mutations must originate from this same test bench.
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      send(res, 403, { error: '请从测试台页面提交。' }); return;
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      send(res, 200, { configured: false, model: null, quality: null, providerSelectionRequired: true }); return;
    }
    if (req.method === 'POST' && pathname === '/api/providers') {
      const { secret } = z.object({ secret: z.string().max(4096) }).strict().parse(await jsonBody(req));
      send(res, 200, { providers: await listProviders(envFile, secret) }); return;
    }
    if (req.method === 'GET' && pathname === '/api/queue') {
      send(res, 200, { ...imageQueue.snapshot(), activeTasks: active.execute.size, queuedTasks: queues.execute.length }); return;
    }
    if (req.method === 'POST' && pathname === '/api/queue') {
      const settings = z.object({ limit: z.number().int().min(1).max(120) }).strict().parse(await jsonBody(req));
      const tmp = `${queueSettings}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(settings), { flag: 'wx' }); await fs.rename(tmp, queueSettings);
      imageQueue.setLimit(settings.limit); pump('execute');
      send(res, 200, imageQueue.snapshot()); return;
    }
    if (req.method === 'GET' && pathname === '/api/library') {
      send(res, 200, { gifs: await library('gif'), references: await library('reference') }); return;
    }
    if (req.method === 'POST' && pathname === '/api/assets/library') {
      const input = z.object({ kind: z.enum(['gif', 'reference']), name: z.string() }).strict().parse(await jsonBody(req));
      if (!(await library(input.kind)).includes(input.name)) throw new Error('素材不存在。');
      const file = path.join(projectDir, 'materials', input.kind === 'gif' ? 'gifs' : 'references', input.name);
      send(res, 201, await saveAsset(input.kind, input.name, await fs.readFile(file))); return;
    }
    if (req.method === 'POST' && pathname === '/api/assets') {
      const kind = z.enum(['gif', 'reference']).parse(url.searchParams.get('kind'));
      send(res, 201, await saveAsset(kind, url.searchParams.get('name') ?? kind, await body(req, kind === 'gif' ? 100 * 1024 * 1024 : 30 * 1024 * 1024))); return;
    }
    const assetApi = pathname.match(/^\/api\/assets\/([a-f0-9-]+)$/);
    if (req.method === 'GET' && assetApi) {
      const asset = await readAsset(root, assetApi[1]!);
      if (asset.kind === 'gif') await enqueueAnalysis(asset.id);
      send(res, 200, asset); return;
    }
    const analysisApi = pathname.match(/^\/api\/assets\/([a-f0-9-]+)\/analysis$/);
    if (req.method === 'GET' && analysisApi) {
      const asset = await readAsset(root, analysisApi[1]!);
      if (asset.kind !== 'gif') throw new Error('Only GIF assets have timeline analysis.');
      await enqueueAnalysis(asset.id);
      send(res, 200, await readAnalysisState(assetDir(root, asset.id))); return;
    }
    if (req.method === 'GET' && pathname === '/api/tasks') {
      const tasks = await Promise.all((await taskIds()).map(id => readTask(root, id)));
      send(res, 200, await Promise.all(tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(t => describeTask(root, t)))); return;
    }
    if (req.method === 'POST' && pathname === '/api/tasks') {
      const { provider, data } = splitProviderInput(await jsonBody(req));
      const config = await resolveProvider(envFile, provider, false);
      const task = await createTask(root, data, config ? providerIdentity(config) : null);
      enqueue('prepare', task.id); send(res, 202, await describeTask(root, task)); return;
    }
    const actionMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/actions$/);
    const anchorMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/anchor$/);
    if (req.method === 'POST' && anchorMatch) {
      const id = z.string().uuid().parse(anchorMatch[1]), { provider, data: action } = splitProviderInput(await jsonBody(req));
      if (submitting.has(id)) { send(res, 409, { error: '此任务正在处理操作，请等待。' }); return; }
      submitting.add(id);
      try {
        const config = (await resolveProvider(envFile, provider))!;
        const result = await approveAnchorAction(root, id, action, config);
        if (result.enqueued) enqueue('prepare', result.task.id, result.task.trialFor ? config : undefined);
        send(res, 202, await describeTask(root, result.task));
      } finally { submitting.delete(id); }
      return;
    }
    if (req.method === 'POST' && actionMatch) {
      const id = z.string().uuid().parse(actionMatch[1]), { provider, data: action } = splitProviderInput(await jsonBody(req));
      if (submitting.has(id)) { send(res, 409, { error: '此任务正在排队，请等待。' }); return; }
      submitting.add(id);
      try {
        const config = action.mode === 'recover' ? undefined : await resolveProvider(envFile, provider, false);
        const result = await approveTaskAction(root, id, action, config);
        if (result.enqueued) enqueue('execute', id, config);
        send(res, 202, await describeTask(root, result.task));
      } finally { submitting.delete(id); }
      return;
    }
    const promptMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/prompts\/(\d+)$/);
    if (req.method === 'GET' && promptMatch) {
      const task = await readTask(root, z.string().uuid().parse(promptMatch[1]));
      const sheet = task.sheets?.find(s => s.index === Number(promptMatch[2]));
      if (!sheet) throw new Error('该版尚未准备好。');
      const dir = path.join(taskDir(root, task.id), 'plans', sheet.directory), plan = await readAiPlan(path.join(dir, 'plan.json'));
      const bytes = await fs.readFile(path.join(dir, plan.prompt.file));
      if (sha256(bytes) !== plan.prompt.sha256) throw new Error('提示词快照已变化，请重新生成草稿。');
      send(res, 200, { index: sheet.index, version: plan.prompt.version, sha256: plan.prompt.sha256, text: bytes.toString('utf8') }); return;
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)(\/submit)?$/);
    if (taskMatch) {
      const id = z.string().uuid().parse(taskMatch[1]);
      if (req.method === 'GET' && !taskMatch[2]) { send(res, 200, await describeTask(root, await readTask(root, id))); return; }
      if (req.method === 'POST' && taskMatch[2]) {
        const { provider, data } = splitProviderInput(await jsonBody(req));
        const { draftHash } = z.object({ draftHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(data);
        if (submitting.has(id)) { send(res, 409, { error: '此草稿正在提交，请等待。' }); return; }
        submitting.add(id);
        try {
          const config = (await resolveProvider(envFile, provider))!;
          const result = await approveDraft(root, id, draftHash, config);
          if (result.enqueued) enqueue('execute', id, config);
          send(res, 202, await describeTask(root, result.task));
        } finally { submitting.delete(id); }
        return;
      }
    }
    const assetMatch = pathname.match(/^\/files\/assets\/([a-f0-9-]+)\/(source\.gif|reference\.png)$/);
    if (req.method === 'GET' && assetMatch) {
      await serveFile(res, path.join(assetDir(root, assetMatch[1]!), assetMatch[2]!), assetMatch[2]!.endsWith('.gif') ? 'image/gif' : 'image/png'); return;
    }
    const fileMatch = pathname.match(/^\/files\/tasks\/([a-f0-9-]+)\/(.+)$/);
    if (req.method === 'GET' && fileMatch) {
      const file = fileMatch[2]!;
      if (!/^[a-zA-Z0-9_/-]+\.(png|gif)$/.test(file) || file.split('/').some(p => p === '..' || p === '.')) throw new Error('Invalid artifact path.');
      await serveFile(res, path.join(taskDir(root, fileMatch[1]!), file), file.endsWith('.gif') ? 'image/gif' : 'image/png'); return;
    }
    if (req.method === 'GET' && ['/', '/app.js', '/providers.js', '/styles.css'].includes(pathname)) {
      const file = pathname.endsWith('.js') ? path.join(projectDir, 'dist-web', path.basename(pathname))
        : path.join(projectDir, 'web', pathname === '/' ? 'index.html' : 'styles.css');
      await serveFile(res, file, pathname === '/' ? 'text/html; charset=utf-8' : pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'); return;
    }
    send(res, 404, { error: 'Not found' });
  }
  function stop() { stopping = true; jobConfigs.clear(); for (const child of children) child.kill('SIGTERM'); server.close(); }
  return { server, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dataDir = path.resolve(process.env.GIF_LAB_DATA_DIR ?? path.join(homedir(), 'experiments', date, 'gif-character-replacer-web'));
  const port = Number(process.env.GIF_LAB_PORT ?? 3087);
  const host = process.env.GIF_LAB_HOST ?? '0.0.0.0';
  const lab = await createLabServer({ dataDir, projectDir, envFile: path.join(projectDir, '.env') });
  lab.server.listen(port, host, () => console.log(`GIF test bench: http://${host}:${port} · data ${dataDir}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, lab.stop);
}
