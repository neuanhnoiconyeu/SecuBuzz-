/**
 * Realtime ↔ DATA composition (Secure Realtime Integration). `attachRealtimeToData` mounts the
 * Socket.IO server on the HTTP server that serves DATA and delegates every security decision to the
 * DATA application object. See `server/docs/realtime-data-integration.md`.
 */
export { attachRealtimeToData, DATA_REVALIDATION_INTERVAL_MS, transportSecurityFor } from './bridge.ts';
export type { DataRealtime, DataRealtimeOptions } from './bridge.ts';
export { createDataAuthorizer } from './authorizer.ts';
export type { DataAuthorizerOptions } from './authorizer.ts';
export { createDataConnectionBinder } from './binder.ts';
export { observeDataChanges } from './changes.ts';
export type { ChangeObserver, ChangeObserverOptions } from './changes.ts';
export { assertDataApplication, DataBridgeError } from './types.ts';
export type { DataApplication } from './types.ts';
