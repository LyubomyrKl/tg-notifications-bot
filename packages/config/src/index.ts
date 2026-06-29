import { z } from 'zod';

/**
 * Single, validated source of runtime configuration.
 * Every package/app reads config through here — no `process.env` access scattered
 * across the codebase, and the process fails fast on a bad/missing env var.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Bot token is optional so the API can boot in environments without Telegram
  // (CI, local API-only work). The bot runtime simply stays dormant if absent.
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_BOT_USERNAME: z.string().optional().default(''),
  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_WEBHOOK_URL: z.string().optional().default(''),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

/** Parse + validate process.env once, then memoize. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — drop the memoized config so a new env can be parsed. */
export function resetConfigCache(): void {
  cached = null;
}
