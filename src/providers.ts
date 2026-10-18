import fs from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parse } from 'dotenv';
import { z } from 'zod';
import { parseAiConfig, type AiConfig } from './ai-config.js';

export class ProviderAccessError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}
const browserConfig = z.object({ baseUrl: z.string().min(1).max(2048), apiKey: z.string().trim().min(1).max(4096),
  model: z.string().trim().min(1).max(200), quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000) }).strict();
const selectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('browser'), config: browserConfig }).strict(),
  z.object({ kind: z.literal('server'), id: z.string().min(1).max(64), secret: z.string().min(1).max(4096) }).strict(),
]);
const entrySchema = z.union([
  z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).strict(),
  browserConfig.extend({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict(),
]);
async function environment(file: string) {
  try { return { ...process.env, ...parse(await fs.readFile(file)) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...process.env }; throw error; }
}
function fromBrowser(config: z.infer<typeof browserConfig>, source: 'browser' | 'server'): AiConfig {
  return parseAiConfig({ OPENAI_BASE_URL: config.baseUrl, OPENAI_API_KEY: config.apiKey, OPENAI_IMAGE_MODEL: config.model,
    OPENAI_IMAGE_QUALITY: config.quality, OPENAI_IMAGE_TIMEOUT_MS: config.timeoutMs, PROVIDER_SOURCE: source });
}
function authenticate(env: NodeJS.ProcessEnv, secret: unknown) {
  const expected = env.GIF_LAB_PROVIDER_SECRET?.trim();
  if (!expected) throw new ProviderAccessError('服务端未配置 provider 列表访问 secret。', 503);
  const hash = (s: string) => createHash('sha256').update(s).digest();
  if (typeof secret !== 'string' || !timingSafeEqual(hash(secret), hash(expected))) throw new ProviderAccessError('Provider 列表访问 secret 不正确。');
}
function serverEntries(env: NodeJS.ProcessEnv) {
  try {
    const entries = z.array(entrySchema).max(32).parse(env.GIF_LAB_PROVIDERS ? JSON.parse(env.GIF_LAB_PROVIDERS) : [{ id: 'default', envPrefix: 'OPENAI' }]);
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('Duplicate provider IDs');
    return entries.map(entry => ({ id: entry.id, config: 'envPrefix' in entry
      ? parseAiConfig({ OPENAI_BASE_URL: env[`${entry.envPrefix}_BASE_URL`], OPENAI_API_KEY: env[`${entry.envPrefix}_API_KEY`],
        OPENAI_IMAGE_MODEL: env[`${entry.envPrefix}_IMAGE_MODEL`], OPENAI_IMAGE_QUALITY: env[`${entry.envPrefix}_IMAGE_QUALITY`],
        OPENAI_IMAGE_TIMEOUT_MS: env[`${entry.envPrefix}_IMAGE_TIMEOUT_MS`], PROVIDER_SOURCE: 'server' }) : fromBrowser(entry, 'server') }));
  } catch { throw new ProviderAccessError('服务端 provider 列表配置无效，请检查 .env。', 503); }
}
export async function listProviders(file: string, secret: unknown) {
  const env = await environment(file); authenticate(env, secret);
  return serverEntries(env).map(({ id, config }) => {
    const url = new URL(config.OPENAI_BASE_URL);
    return { id, host: `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}` };
  });
}
export async function resolveProvider(file: string, input: unknown, required = true): Promise<AiConfig | undefined> {
  if (input === undefined || input === null) {
    if (required) throw new ProviderAccessError('请先选择浏览器 provider，或用 secret 解锁并选择服务端 provider。', 400);
    return undefined;
  }
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) throw new ProviderAccessError('Provider 配置不完整或格式不正确。', 400);
  if (parsed.data.kind === 'browser') {
    try { return fromBrowser(parsed.data.config, 'browser'); }
    catch { throw new ProviderAccessError('自定义 provider 的地址或参数不正确。', 400); }
  }
  const selected = parsed.data;
  const env = await environment(file); authenticate(env, selected.secret);
  const entry = serverEntries(env).find(e => e.id === selected.id);
  if (!entry) throw new ProviderAccessError('所选服务端 provider 已不存在，请重新解锁列表。', 400);
  return entry.config;
}
export function splitProviderInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderAccessError('请求必须是 JSON 对象。', 400);
  const { provider, ...data } = input as Record<string, unknown>;
  return { provider, data };
}
