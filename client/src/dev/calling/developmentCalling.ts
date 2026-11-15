export function developmentCallingEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEV_CALLS_ENABLED === 'true';
}
