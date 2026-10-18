import fs from 'node:fs/promises';
import { parse } from 'dotenv';
import { z } from 'zod';
import OpenAI from 'openai';

const schema = z.object({
  OPENAI_BASE_URL: z.string().url(), OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_IMAGE_MODEL: z.string().trim().min(1),
  OPENAI_IMAGE_QUALITY: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  OPENAI_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1800000).default(300000),
  PROVIDER_SOURCE: z.enum(['browser', 'server']).optional(),
});
export type AiConfig = z.infer<typeof schema>;

const providerErrors = new WeakMap<Error, unknown>();
class ImageClient extends OpenAI {
  protected override makeStatusError(status: number, body: Object, message: string | undefined, headers: Headers) {
    const error = super.makeStatusError(status, body, message, headers);
    // SDK error construction keeps only body.error; compatible gateways may put
    // useful messages, task IDs or even image data at the top level instead.
    providerErrors.set(error, body);
    return error;
  }
}
export function providerErrorBody(error: unknown): unknown {
  return error instanceof OpenAI.APIError ? providerErrors.get(error) : undefined;
}
export function redactProviderText(text: string, config: AiConfig) {
  const scrubbed = text.split(config.OPENAI_API_KEY).join('[REDACTED]');
  return config.PROVIDER_SOURCE === 'browser' ? scrubbed.split(config.OPENAI_BASE_URL).join('[browser-provider]') : scrubbed;
}

/** Explicit config file wins over inherited environment; never log this object. */
export async function readAiConfig(file = '.env'): Promise<AiConfig> {
  return parseAiConfig({ ...process.env, ...parse(await fs.readFile(file)) });
}
export function parseAiConfig(input: unknown): AiConfig {
  const config = schema.parse(input);
  const url = new URL(config.OPENAI_BASE_URL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must be HTTP(S) without embedded credentials, query or fragment.');
  }
  config.OPENAI_BASE_URL = config.OPENAI_BASE_URL.replace(/\/$/, '');
  return config;
}

export function imageClient(config: AiConfig, fetchOverride?: typeof fetch): OpenAI {
  return new ImageClient({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL,
    timeout: config.OPENAI_IMAGE_TIMEOUT_MS, maxRetries: 0, ...(fetchOverride ? { fetch: fetchOverride } : {}) });
}

export async function checkAi(config: AiConfig) {
  const models = await imageClient(config).models.list();
  const available = models.data.map(m => m.id).filter(id => id.includes('image'));
  return { endpoint: config.OPENAI_BASE_URL, requestedModel: config.OPENAI_IMAGE_MODEL,
    listed: available.includes(config.OPENAI_IMAGE_MODEL), imageModels: available,
    note: 'A model listing does not establish supported image dimensions or actual backend identity.' };
}
