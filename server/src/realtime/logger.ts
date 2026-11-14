import type { LogFields, LogLevel, RealtimeLogger } from './contracts.ts';

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const MAX_STRING_FIELD = 200;

/**
 * Normalizes log fields: primitive values only, bounded strings with control characters replaced
 * (prevents log injection), invalid field names dropped. The server never passes payloads,
 * cookies, tokens, session IDs or ciphertext as fields; this is defense in depth.
 */
export function sanitizeLogFields(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  if (!fields) return safe;
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAME.test(name)) continue;
    if (typeof value === 'string') safe[name] = value.slice(0, MAX_STRING_FIELD).replace(CONTROL_CHARACTERS, '?');
    else if (typeof value === 'number') safe[name] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'boolean' || value === null) safe[name] = value;
  }
  return safe;
}

/** JSON-lines logger: `info` to stdout, `warn`/`error` to stderr. */
export function createConsoleLogger(
  stdout: { write(line: string): unknown } = process.stdout,
  stderr: { write(line: string): unknown } = process.stderr,
): RealtimeLogger {
  return {
    log(level: LogLevel, event: string, fields?: LogFields) {
      const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...sanitizeLogFields(fields) });
      (level === 'info' ? stdout : stderr).write(`${line}\n`);
    },
  };
}

export const silentLogger: RealtimeLogger = { log() { /* intentionally silent */ } };

/** A failing logger must never break connection handling. */
export function safeLog(logger: RealtimeLogger, level: LogLevel, event: string, fields?: LogFields): void {
  try {
    logger.log(level, event, sanitizeLogFields(fields));
  } catch {
    /* Logging is best effort. */
  }
}
