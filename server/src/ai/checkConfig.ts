/**
 * `npm run ai:check-config` (runs `node --env-file-if-exists=.env src/ai/checkConfig.ts`).
 * Prints a sanitized report and exits 1 when the AI configuration is invalid. It never contacts
 * Google: there is no health check, model listing or token counting.
 */
import { existsSync } from 'node:fs';
import { describeAiConfig } from './configReport.ts';

const useSystemCa = process.execArgv.includes('--use-system-ca') ||
  /(?:^|\s)--use-system-ca(?:\s|$)/u.test(process.env.NODE_OPTIONS ?? '');
const report = describeAiConfig(process.env, { envFileFound: existsSync('.env'), useSystemCa });
process.stdout.write(`${report.lines.join('\n')}\n`);
process.exitCode = report.ok ? 0 : 1;
