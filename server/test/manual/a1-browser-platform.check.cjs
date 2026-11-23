/* Native browser prerequisites only. No SecuBuzz schema/format-2, migration or quarantine implementation.
 * Every database is an ephemeral sentinel fixture at an intercepted .invalid origin.
 * Run from server: node --test test/manual/a1-browser-platform.check.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { before, after, test } = require('node:test');
const { foundationTitle } = require('../support/a1-catalog.ts');
const { chromium } = createRequire(resolve(__dirname, '../../../client/package.json'))('@playwright/test');
if (process.env.NODE_ENV === 'production') throw new Error('A1 browser fixtures cannot run in production.');

const origin = 'https://a1-platform-fixture.invalid';
let browser, context;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/')
    ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>A1 disposable storage prerequisite fixture</title>' })
    : route.abort('blockedbyclient'));
});
after(async () => { await context?.close(); await browser?.close(); });

async function tabs() {
  const pages = [await context.newPage(), await context.newPage()];
  await Promise.all(pages.map(page => page.goto(origin + '/sentinel')));
  return pages;
}
async function seed(page, name, value = 'BEFORE', keepOpen = false) {
  assert(name.startsWith('a1-platform-only-'));
  await page.evaluate(async ({ name, value, keepOpen }) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('sentinels');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sentinels', 'readwrite'); tx.objectStore('sentinels').put(value, 'marker');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    if (keepOpen) { window.__a1FixtureDb = db; window.__a1CachedSentinel = value; } else db.close();
  }, { name, value, keepOpen });
}

test(foundationTitle('P12'), { timeout: 20000 }, async () => {
  const pages = await tabs(), name = 'a1-platform-only-' + randomUUID();
  try {
    await seed(pages[0], name, 0);
    for (let round = 0; round < 5; round++) await Promise.all(pages.map(page => page.evaluate(async name => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('sentinels', 'readwrite'), store = tx.objectStore('sentinels'), r = store.get('marker');
          r.onsuccess = () => store.put(r.result + 1, 'marker'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    }, name)));
    const total = await pages[0].evaluate(async name => {
      const db = await new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
      try { return await new Promise(resolve => { const r = db.transaction('sentinels').objectStore('sentinels').get('marker'); r.onsuccess = () => resolve(r.result); }); }
      finally { db.close(); }
    }, name);
    assert.equal(total, 10);
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test(foundationTitle('P13'), { timeout: 20000 }, async () => {
  const pages = await tabs(), name = 'a1-platform-only-' + randomUUID();
  try {
    await seed(pages[0], name);
    const result = await pages[1].evaluate(async name => {
      const db = await new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
      try {
        let requestSucceeded = false;
        await new Promise((resolve, reject) => {
          const tx = db.transaction('sentinels', 'readwrite');
          const r = tx.objectStore('sentinels').put('UNCOMMITTED', 'marker');
          r.onsuccess = () => { requestSucceeded = true; tx.abort(); };
          tx.onabort = resolve; tx.oncomplete = () => reject(new Error('An aborted transaction committed'));
        });
        const value = await new Promise(resolve => { const r = db.transaction('sentinels').objectStore('sentinels').get('marker'); r.onsuccess = () => resolve(r.result); });
        return { requestSucceeded, value, version: db.version };
      } finally { db.close(); }
    }, name);
    assert.deepEqual(result, { requestSucceeded: true, value: 'BEFORE', version: 1 });
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test(foundationTitle('P14'), { timeout: 20000 }, async () => {
  const pages = await tabs(), name = 'a1-platform-only-' + randomUUID();
  try {
    await seed(pages[0], name);
    const result = await pages[1].evaluate(async name => {
      const failure = await new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 2); // Generic sentinel schema version; NOT watermark format 2.
        r.onupgradeneeded = () => { r.result.createObjectStore('never-committed'); r.transaction.objectStore('sentinels').put('UNCOMMITTED', 'marker'); r.transaction.abort(); };
        r.onsuccess = () => { r.result.close(); reject(new Error('The interrupted upgrade unexpectedly committed')); };
        r.onerror = event => { event.preventDefault(); resolve(r.error.name); };
      });
      const db = await new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
      try {
        const value = await new Promise(resolve => { const r = db.transaction('sentinels').objectStore('sentinels').get('marker'); r.onsuccess = () => resolve(r.result); });
        return { failure, version: db.version, stores: [...db.objectStoreNames], value };
      } finally { db.close(); }
    }, name);
    assert.deepEqual(result, { failure: 'AbortError', version: 1, stores: ['sentinels'], value: 'BEFORE' });
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test(foundationTitle('P15'), { timeout: 20000 }, async () => {
  const pages = await tabs(), name = 'a1-platform-only-' + randomUUID();
  try {
    await seed(pages[0], name, 'BEFORE', true);
    const blocked = await pages[1].evaluate(name => new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onblocked = () => resolve(true);
      r.onsuccess = () => { window.__a1UpgradedFixture = r.result; };
      r.onerror = () => reject(r.error);
    }), name);
    assert.equal(blocked, true);
    assert.equal(await pages[0].evaluate(() => window.__a1FixtureDb.version), 1);
    await pages[0].evaluate(() => window.__a1FixtureDb.close());
    await pages[1].waitForFunction(() => !!window.__a1UpgradedFixture);
    const result = await pages[1].evaluate(async name => {
      const db = window.__a1UpgradedFixture;
      const oldOpen = await new Promise(resolve => {
        const r = indexedDB.open(name, 1); r.onerror = event => { event.preventDefault(); resolve(r.error.name); };
        r.onsuccess = () => { r.result.close(); resolve('unexpected success'); };
      });
      return { oldOpen, version: db.version, stores: [...db.objectStoreNames] };
    }, name);
    assert.deepEqual(result, { oldOpen: 'VersionError', version: 2, stores: ['sentinels'] });
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test(foundationTitle('P16'), { timeout: 20000 }, async () => {
  const pages = await tabs(), name = 'a1-platform-only-' + randomUUID();
  try {
    await seed(pages[0], name, 'SYNTHETIC_OLD_CACHE', true);
    await pages[0].evaluate(() => { window.__a1FixtureDb.onversionchange = () => { window.__a1FixtureDb.close(); window.__a1Closed = true; }; });
    await pages[1].evaluate(name => new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 2); r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error);
    }), name);
    const result = await pages[0].evaluate(() => {
      let handleError;
      try { window.__a1FixtureDb.transaction('sentinels'); } catch (error) { handleError = error.name; }
      return { closed: window.__a1Closed, handleError, cached: window.__a1CachedSentinel };
    });
    assert.deepEqual(result, { closed: true, handleError: 'InvalidStateError', cached: 'SYNTHETIC_OLD_CACHE' });
    // This intentionally demonstrates a limitation; it is NOT secure-client-shutdown acceptance.
  } finally { await Promise.all(pages.map(page => page.close())); }
});
