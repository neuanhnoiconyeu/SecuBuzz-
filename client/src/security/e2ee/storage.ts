import { E2eeError, type DeviceIdentity } from './model';

/** Origin storage is account namespaced, not a defense against compromised same-origin JS. */
export class BrowserKeyStore {
  private database: Promise<IDBDatabase> | undefined;
  private closed = false;
  constructor(readonly accountId: string, private readonly name = 'secubuzz-e2ee-v1') {}
  private key(kind: string, id: string): string { return JSON.stringify([this.accountId, kind, id]); }
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new E2eeError('disposed'));
    if (!this.database) this.database = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new E2eeError('storage_unavailable')); return; }
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('records'); request.result.createObjectStore('nonces'); };
      request.onerror = () => reject(new E2eeError('storage_unavailable'));
      request.onblocked = () => reject(new E2eeError('storage_unavailable'));
      request.onsuccess = () => {
        const db = request.result; db.onversionchange = () => { db.close(); this.closed = true; };
        if (this.closed) { db.close(); reject(new E2eeError('disposed')); } else resolve(db);
      };
    });
    return this.database;
  }
  private async transaction<T>(storeName: 'records' | 'nonces', mode: IDBTransactionMode, work: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
    const db = await this.open(); if (this.closed) throw new E2eeError('disposed');
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode); let value: T;
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(new E2eeError('storage_unavailable')); tx.onabort = () => reject(new E2eeError('storage_unavailable'));
      try { work(tx.objectStore(storeName), v => { value = v; }); } catch { tx.abort(); }
    });
  }
  get<T>(kind: string, id = ''): Promise<T | undefined> {
    return this.transaction('records', 'readonly', (store, set) => { const r = store.get(this.key(kind, id)); r.onsuccess = () => set(r.result as T | undefined); });
  }
  put<T>(kind: string, id: string, value: T): Promise<void> {
    return this.transaction('records', 'readwrite', (store, set) => { store.put(value, this.key(kind, id)); set(undefined); });
  }
  remove(kind: string, id: string): Promise<void> { return this.transaction('records', 'readwrite', (store, set) => { store.delete(this.key(kind, id)); set(undefined); }); }
  clearPending(conversationId: string, messageId: string): Promise<void> {
    return this.transaction('records', 'readwrite', (store, set) => { const key = this.key('pending', conversationId), r = store.get(key);
      r.onsuccess = () => { if (r.result?.id === messageId) store.delete(key); set(undefined); }; });
  }
  putIfAbsent<T>(kind: string, id: string, candidate: T): Promise<T> {
    return this.transaction('records', 'readwrite', (store, set) => {
      const key = this.key(kind, id), r = store.get(key);
      r.onsuccess = () => { if (r.result !== undefined) set(r.result as T); else { store.add(candidate, key); set(candidate); } };
    });
  }
  async enroll(candidate: DeviceIdentity): Promise<DeviceIdentity> {
    return this.transaction('records', 'readwrite', (store, set) => {
      const r = store.get(this.key('device', ''));
      r.onsuccess = () => {
        if (r.result !== undefined) set(r.result as DeviceIdentity);
        else { store.add(candidate, this.key('device', '')); store.put(true, this.key('enrolled', '')); set(candidate); }
      };
    });
  }
  /** The unique IDB key reserves a nonce across refresh, restored CryptoKeys and all tabs. */
  async reserveNonce(materialId: string, iv: string): Promise<boolean> {
    return this.transaction('nonces', 'readwrite', (store, set) => {
      const r = store.add(true, this.key('nonce', JSON.stringify([materialId, iv])));
      r.onsuccess = () => set(true);
      r.onerror = event => { if (r.error?.name === 'ConstraintError') { event.preventDefault(); event.stopPropagation(); set(false); } };
    });
  }
  close(): void { this.closed = true; void this.database?.then(db => db.close(), () => {}); }
}
