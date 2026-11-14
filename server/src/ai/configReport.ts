/**
 * Sanitized, network-free description of the AI configuration for `npm run ai:check-config`.
 * It never prints the Gemini key, its length or prefix, the consent secret, or unrecognized values.
 */
import { AI_LIMIT_DEFAULTS, AiConfigError, loadAiConfig } from './config.ts';
import { AI_PROVIDER_NAME, AI_SUPPORTED_MODELS } from './protocol.ts';

export interface AiConfigReportContext {
  /** Whether `server/.env` exists in the working directory (`--env-file-if-exists` loads it silently). */
  readonly envFileFound: boolean;
  /** Whether this process runs with `--use-system-ca`. */
  readonly useSystemCa: boolean;
}

export interface AiConfigReport {
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly lines: readonly string[];
}

function present(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function allowlisted(value: string | undefined, allowed: readonly string[]): string {
  if (!present(value)) return 'unset';
  return allowed.includes(value as string) ? value as string : 'unsupported value (not shown)';
}

function switchState(value: string | undefined): string {
  if (value === 'true') return 'true (remote AI ON)';
  if (value === 'false') return 'false (remote AI off)';
  if (!present(value)) return 'unset (remote AI off)';
  return 'unrecognized value (treated as off)';
}

function limit(env: NodeJS.ProcessEnv, name: string, value: number | null, fallback: number | null, note: string): string {
  if (value === null) return `  ${name}: unset (required to enable; copy it from the AI Studio rate-limit page)`;
  return `  ${name}: ${value} (${present(env[name]) || fallback === null ? note : `default; ${note}`})`;
}

export function describeAiConfig(env: NodeJS.ProcessEnv, context: AiConfigReportContext): AiConfigReport {
  const lines = [
    'SecuBuzz AI configuration check. No network requests are made.',
    `  server/.env: ${context.envFileFound ? 'found and loaded' : 'not found (process environment only)'}`,
    `  AI_REMOTE_ENABLED: ${switchState(env.AI_REMOTE_ENABLED)}`,
    `  AI_PROVIDER: ${allowlisted(env.AI_PROVIDER, [AI_PROVIDER_NAME])}`,
    `  GEMINI_MODEL: ${allowlisted(env.GEMINI_MODEL, AI_SUPPORTED_MODELS)}`,
    `  GEMINI_API_KEY: ${present(env.GEMINI_API_KEY) ? 'present (value not shown)' : 'absent'}`,
    `  AI_CONSENT_SECRET: ${present(env.AI_CONSENT_SECRET) ? 'present (value not shown)' : 'absent (a random per-process secret is used outside production)'}`,
    `  TLS: --use-system-ca ${context.useSystemCa ? 'active' : 'inactive'}; NODE_TLS_REJECT_UNAUTHORIZED ${
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? 'is 0 (certificate checks disabled; remove it)' : present(env.NODE_TLS_REJECT_UNAUTHORIZED) ? 'set' : 'unset'
    }; NODE_EXTRA_CA_CERTS ${present(env.NODE_EXTRA_CA_CERTS) ? 'set' : 'unset'}`,
  ];
  let ok = true;
  let enabled = false;
  try {
    const config = loadAiConfig(env, { randomSecret: () => Buffer.alloc(32) });
    enabled = config.enabled;
    const { limits } = config;
    lines.push(
      limit(env, 'AI_PROJECT_RPM', limits.projectPerMinute, null, 'Google project quota'),
      limit(env, 'AI_PROJECT_RPD', limits.projectPerDay, null, 'Google project quota, resets at midnight Pacific'),
      limit(env, 'AI_USER_RPM', limits.userPerMinute, AI_LIMIT_DEFAULTS.userPerMinute, 'SecuBuzz policy'),
      limit(env, 'AI_USER_RPD', limits.userPerDay, AI_LIMIT_DEFAULTS.userPerDay, 'SecuBuzz policy'),
      limit(env, 'AI_MAX_CONCURRENT', limits.maxConcurrent, AI_LIMIT_DEFAULTS.maxConcurrent, 'per quota scope; one per user'),
      limit(env, 'AI_MAX_INPUT_CHARS', limits.maxInputChars, AI_LIMIT_DEFAULTS.maxInputChars, 'UTF-16 code units'),
      limit(env, 'AI_MAX_OUTPUT_TOKENS', limits.maxOutputTokens, AI_LIMIT_DEFAULTS.maxOutputTokens, 'includes thinking tokens'),
      limit(env, 'AI_TIMEOUT_MS', config.timeoutMs, AI_LIMIT_DEFAULTS.timeoutMs, 'milliseconds'),
      `  AI_QUOTA_SCOPE: ${config.quotaScope}`,
      `  AI_ALLOWED_ORIGINS: ${config.allowedOrigins.size === 0 ? 'none (every AI request is refused)' : [...config.allowedOrigins].join(', ')}`,
      `  AI_SESSION_COOKIE: ${config.sessionCookieName}`,
      `  Usage store: ${config.localDevMemoryQuota ? 'in-memory development store (AI_LOCAL_DEV_MEMORY_QUOTA=true)' : 'must be injected by the API server (durable, shared)'}`,
      `  Result: valid. ${config.enabled ? 'Remote AI is ENABLED; requests still need a session resolver, CSRF verifier and usage store.' : 'Remote AI is disabled; no Gemini request can be made.'}`,
    );
  } catch (error) {
    ok = false;
    // AiConfigError messages are authored in config.ts and never include secrets.
    lines.push(`  Result: INVALID. ${error instanceof AiConfigError ? error.message : 'Unexpected error while reading the configuration.'}`);
  }
  if (!context.useSystemCa) {
    lines.push('  Note: start the API process with "node --use-system-ca" when HTTPS inspection (for example Avast) re-signs certificates.');
  }
  return { ok, enabled, lines };
}
