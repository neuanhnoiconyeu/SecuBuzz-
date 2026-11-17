export * from '../../../shared/directCalls.ts';
import type { CallErrorCode } from '../../../shared/directCalls.ts';
export const callError = (code: CallErrorCode): { status: 'error'; code: CallErrorCode } => ({ status: 'error', code });
