// Isolated demo regression: real chat components, Web Crypto, IndexedDB and Chrome MediaRecorder.
// Faults below affect only this test's transport proxy; no application services or data are changed.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { build, stop } = require('../../server/node_modules/esbuild');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..'), artifacts = path.join(root, '.cache', 'phase6-demo');
fs.mkdirSync(artifacts, { recursive: true });
let browser, server, page;
const checks = [];
function passed(name) { checks.push(name); console.log('PASS ' + name); }
function pdfFixture() {
  const content = 'BT /F1 14 Tf 20 100 Td (Phase 6 fixture) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'];
  let result = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(result); result += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(result + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}
(async () => {
  const bundle = await build({ absWorkingDir: path.join(root, 'client'), tsconfig: 'tsconfig.json', bundle: true, write: false,
    outdir: 'out', platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/cursors/*'],
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' },
    stdin: { resolveDir: path.join(root, 'client'), loader: 'tsx', contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import './src/styles/themes.css'; import './src/styles/typography.css'; import './src/styles/motion.css'; import './src/app/globals.css';
      import { YahooChatWindow } from './src/components/YahooChatWindow';
      import { createDemoMessengerSession } from './src/auth/messengerSession';
      import { ThemeProvider } from './src/theme/ThemeProvider';
      const session = createDemoMessengerSession({ id: 'local-user', username: 'phase6-demo', displayName: 'You', avatar: 'initials', isDemo: true });
      const fault = { sends: [], failSendAt: 0, failDelete: false };
      window.__demoFault = fault;
      const transport = new Proxy(session.transport, { get(target, key) {
        if (key === 'sendMessage') return async message => {
          const attempt = { id: message.id, conversationId: message.conversationId, failed: false }; fault.sends.push(attempt);
          if (fault.sends.length === fault.failSendAt) { attempt.failed = true; throw Error('Isolated send fault'); }
          return target.sendMessage(message);
        };
        if (key === 'deleteMessage') return async (...args) => {
          await new Promise(resolve => setTimeout(resolve, 150));
          if (fault.failDelete) { fault.failDelete = false; throw Error('Isolated unsend fault'); }
          return target.deleteMessage(...args);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      function App() {
        const [id, setId] = useState('securebot-demo'), [drafts, setDrafts] = useState({}), [active, setActive] = useState(true), [mounted, setMounted] = useState(true);
        const conversation = session.conversations.find(item => item.id === id);
        useEffect(() => () => session.dispose(), []);
        return <ThemeProvider><main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
          <nav aria-label="Test conversations" style={{ display: 'flex', flexWrap: 'wrap', flexShrink: 0 }}>
            {session.conversations.map(item => <button key={item.id} onClick={() => setId(item.id)}>{item.displayName}</button>)}
            <button onClick={() => setActive(value => !value)}>Toggle visibility</button><button onClick={() => setMounted(false)}>Unmount chat</button>
          </nav>
          {mounted && <div hidden={!active} style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0 }}><YahooChatWindow
            conversationId={id} contactName={conversation.displayName} conversationType={conversation.type}
            currentUserId={session.user.id} currentUserName="You" cryptoService={session.cryptoService} transport={transport}
            presentationActive={active} conversationIds={session.conversations.map(item => item.id)}
            forwardTargets={session.conversations.filter(item => item.id !== id).map(item => ({ id: item.id, displayName: item.displayName }))}
            draftValue={drafts[id] || ''} onDraftChange={value => setDrafts(old => ({ ...old, [id]: value }))} /></div>}
        </main></ThemeProvider>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` } });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/app.js' ? 'application/javascript' : request.url === '/app.css' ? 'text/css' : 'text/html');
    response.end(request.url === '/app.js' ? js : request.url === '/app.css' ? css : '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{box-sizing:border-box}body{margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}button,input,textarea{font:inherit}nav button{min-height:44px;background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)}</style><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__revoked = []; window.__streams = [];
    const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.__revoked.push(url); revoke(url); };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); window.__streams.push(stream); return stream; };
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const input = () => page.getByRole('textbox', { name: /^Message to / });
  const nav = name => page.getByRole('navigation', { name: 'Test conversations' }).getByRole('button', { name, exact: true });
  const rowFor = text => page.locator('.message-row-outgoing').filter({ has: page.locator('.message-text').filter({ hasText: text }) }).first();
  const menu = async (row, name) => { await row.hover(); await row.getByRole('button', { name: 'More actions', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
  const send = async text => { await expect(input()).toBeEnabled(); await input().fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(input()).toHaveValue(''); };
  await send('Phase 6 original\nSecond line');
  const originalId = await rowFor('Phase 6 original').getAttribute('data-message-id');
  const original = page.locator('[data-message-id="' + originalId + '"]');
  await expect(page.locator('.message-row:not(.message-row-outgoing)')).toHaveCount(1);
  await expect(original.getByText('Read · simulated', { exact: true })).toBeVisible();
  passed('demo send, scripted receive and explicitly simulated status receipts');
  await menu(original, 'Edit'); await page.getByRole('textbox', { name: 'Edit message' }).fill('Phase 6 original\n\nEdited second line');
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(original.locator('.message-text')).toHaveText('Phase 6 original\n\nEdited second line');
  assert.equal(await original.getAttribute('data-message-id'), originalId); await expect(original.getByText('(edited)', { exact: true })).toBeVisible();
  await original.hover(); await original.getByRole('button', { name: 'Reply', exact: true }).click(); await send('Phase 6 reply');
  const reply = rowFor('Phase 6 reply'); await reply.getByRole('button', { name: 'Go to original message from You', exact: true }).click();
  await expect(original).toHaveAttribute('data-message-highlighted', 'true');
  passed('multiline edit preserves identity and reply navigation highlights the original');
  await menu(original, 'Pin'); await page.getByRole('button', { name: 'View pinned messages', exact: true }).click();
  await page.locator('.pinned-message-link').click(); await expect(original).toBeFocused();
  await menu(original, 'Unpin'); await expect(page.getByRole('button', { name: 'View pinned messages', exact: true })).toHaveCount(0);
  await original.hover(); await original.getByRole('button', { name: 'React to message', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'React 👍', exact: true }).click();
  await original.getByRole('button', { name: 'React to message', exact: true }).click(); await page.getByRole('menuitem', { name: 'More reactions', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search emoji' }).fill('pizza'); await page.getByRole('button', { name: 'React with pizza 🍕', exact: true }).click();
  await expect(original.getByRole('button', { name: '👍 1', exact: true })).toHaveCount(0);
  await original.getByRole('button', { name: '🍕 1', exact: true }).click(); await expect(original.getByRole('button', { name: '🍕 1', exact: true })).toHaveCount(0);
  passed('pin/unpin navigation and quick/full reaction replacement/removal work together');
  await menu(original, 'Forward'); const forward = page.getByRole('dialog', { name: 'Forward to', exact: true });
  await forward.getByRole('button', { name: /Ava Morgan/ }).click(); await forward.getByRole('textbox', { name: 'Optional message', exact: true }).fill('Phase 6 forward note');
  await page.evaluate(() => { window.__demoFault.failSendAt = window.__demoFault.sends.length + 2; });
  await forward.getByRole('button', { name: 'Send', exact: true }).click(); await expect(forward.getByRole('alert')).toContainText('optional note was not sent');
  await forward.getByRole('button', { name: 'Send', exact: true }).click(); await expect(forward).not.toBeVisible();
  const attempts = await page.evaluate(() => window.__demoFault.sends.filter(item => item.conversationId === 'demo-direct-ava'));
  assert.equal(attempts.length, 3); assert.equal(attempts[1].id, attempts[2].id); assert.notEqual(attempts[0].id, attempts[1].id);
  await nav('Ava Morgan').click(); await expect(page.locator('.message-row-outgoing')).toHaveCount(2);
  await expect(page.getByText('Forwarded from You', { exact: false })).toBeVisible();
  await nav('SecureBot').click(); passed('partial forward-note failure remains open and retry sends only the failed note with the same ID');
  await page.evaluate(() => { window.__demoFault.failDelete = true; });
  await menu(original, 'Unsend'); const removal = page.getByRole('dialog', { name: 'Who do you want to remove this message for?', exact: true });
  await removal.getByRole('button', { name: 'Remove', exact: true }).click(); await expect(removal.getByRole('alert')).toContainText('Could not unsend');
  await expect(original.locator('.message-text')).toContainText('Edited second line');
  await removal.getByRole('button', { name: 'Remove', exact: true }).click(); await expect(removal).not.toBeVisible();
  await expect(original.locator('.message-text')).toHaveText('This message was deleted.');
  await reply.getByRole('button', { name: 'Go to original message from You', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The original message was deleted.' })).toBeVisible();
  const incoming = page.locator('.message-row:not(.message-row-outgoing)').first(); const incomingId = await incoming.getAttribute('data-message-id');
  await menu(incoming, 'Delete for me'); await expect(page.locator('[data-message-id="' + incomingId + '"]')).toHaveCount(0);
  await menu(reply, 'Unsend'); await removal.getByRole('radio', { name: /Delete for me/ }).check(); await removal.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(reply).toHaveCount(0); passed('async unsend failure preserves content; success, deleted reply originals and both delete scopes stay distinct');
  await input().fill('Before middle after'); await input().evaluate(node => node.setSelectionRange(7, 13));
  await page.getByRole('button', { name: 'Insert emoji', exact: true }).click(); const search = page.getByRole('searchbox', { name: 'Search emoji' });
  await search.fill('woman technologist'); await search.press('Enter'); await expect(input()).toHaveValue('Before middle after');
  await search.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(input()).toHaveValue('Before 👩‍💻 after');
  await expect(input()).toBeFocused(); await page.getByRole('button', { name: 'Send', exact: true }).click();
  passed('advanced emoji insertion respects selection and searching never submits the composer');
  const files = [
    { name: 'phase6.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64') },
    { name: 'phase6.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    { name: 'phase6.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('UEsDBBQAAAAIAIcwdV0V9dR3iAAAALYAAAARAAAAd29yZC9kb2N1bWVudC54bWxFzssNgzAMBuBVogyAaQ8cogArdIUUDEQicWSHR7cvoYdePsv+Zcu2P8OqdmTxFFv9qGrdd/YwIw1bwJjVFUcxR6uXnJMBkGHB4KSihPHKJuLg8tXyDAfxmJgGFPFxDis867qB4HzU5eSbxk+pqcCF3L0WJ6gaNfkzb4wWyrDIt+n2twj/p7ovUEsDBBQAAAAIAIcwdV26d6ScywAAAFMBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbJWQvVLDQAyEX+XmWiYnQ0HB2E4BtEDBC2jOsn3D/c1JCeHtkRNIQUcp7Wq/HfX7U4rmSI1DyYO9dZ3dj/37VyU2qmQe7CpSHwDYr5SQXamUVZlLSyg6tgUq+g9cCO667h58yUJZdrJl2LF/ohkPUczzSdcXSqPI1jxejBtrsFhrDB5FdTjm6Q9l90Nwenn28Boq36jBwti/av0WJjJv2OQFk8bBZ2kTTMUfkiLcZvwXr8xz8HS939JqK56YQ15SdFclYci/PeD8tvEbUEsDBBQAAAAIAIcwdV1fM5VSlQAAAAcBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAMBuCrRD5AnTIwoKZdWLoiLhAlblPRPOSE1+3JwEARA6N///osd8PDr+JGnJcYFLSNhKHvTrTqUoPslpRFbYSswJWSDojZOPI6NzFRqJspsteljjxj0uaiZ8KdlHvkTwO2phitAh5tC+L8TPSPHadpMXSM5uoplB8nvhpV1jxTUXCPbNG+46aygH2Hmxf7F1BLAQIUABQAAAAIAIcwdV0V9dR3iAAAALYAAAARAAAAAAAAAAAAAAAAAAAAAAB3b3JkL2RvY3VtZW50LnhtbFBLAQIUABQAAAAIAIcwdV26d6ScywAAAFMBAAATAAAAAAAAAAAAAAAAALcAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAhzB1XV8zlVKVAAAABwEAAAsAAAAAAAAAAAAAAAAAswEAAF9yZWxzLy5yZWxzUEsFBgAAAAADAAMAuQAAAHECAAAAAA==', 'base64') },
    { name: 'phase6.txt', mimeType: 'text/plain', buffer: Buffer.from('Phase 6 download fixture') },
  ];
  await page.locator('input[type="file"]').setInputFiles([{ name: 'corrupt.docx', mimeType: files[2].mimeType, buffer: Buffer.from('Not a Word document') }]);
  await expect(page.getByRole('alert')).toContainText('corrupt.docx is corrupted'); await expect(page.locator('.composer-attachment-item')).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles(files); await expect(page.locator('.composer-attachment-item')).toHaveCount(4);
  await input().fill('Phase 6 attachment group'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(input()).toHaveValue('');
  const fileRow = rowFor('Phase 6 attachment group'); await expect(fileRow.locator('.message-attachment')).toHaveCount(4);
  const fileMessageId = await fileRow.getAttribute('data-message-id');
  await fileRow.getByRole('button', { name: 'Preview phase6.png', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'phase6.png', exact: true }); await expect(preview.getByRole('img')).toBeVisible();
  await expect.poll(() => preview.getByRole('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await preview.getByRole('button', { name: 'Close attachment preview', exact: true }).click();
  await fileRow.getByRole('button', { name: 'Preview phase6.pdf', exact: true }).click();
  const pdfPreview = page.getByRole('dialog', { name: 'phase6.pdf', exact: true });
  await expect(pdfPreview.getByTitle('PDF preview: phase6.pdf')).toHaveAttribute('src', /^blob:/);
  await pdfPreview.getByRole('button', { name: 'Close attachment preview', exact: true }).click();
  const downloadEvent = page.waitForEvent('download'); await fileRow.getByRole('link', { name: 'Download phase6.txt', exact: true }).click();
  assert.equal((await downloadEvent).suggestedFilename(), 'phase6.txt');
  await menu(fileRow, 'Forward'); await forward.getByRole('button', { name: /Ava Morgan/ }).click(); await forward.getByRole('button', { name: 'Send', exact: true }).click(); await expect(forward).not.toBeVisible();
  await nav('Ava Morgan').click(); await expect(rowFor('Phase 6 attachment group').locator('.message-attachment')).toHaveCount(4);
  await page.reload(); await expect(input()).toBeEnabled(); await expect(page.locator('[data-message-id="' + fileMessageId + '"] .message-attachment')).toHaveCount(4);
  passed('multi-file previews, real download, attachment forwarding and IndexedDB restoration retain demo-only files');
  const record = page.getByRole('button', { name: 'Record voice message', exact: true });
  const stopRecord = page.getByRole('button', { name: 'Stop voice recording', exact: true });
  const play = locator => locator.evaluate(async audio => { const ended = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Playback timed out')), 10000); audio.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once: true }); }); await audio.play(); await ended; return audio.currentTime; });
  await record.click(); await expect(stopRecord).toBeVisible(); await page.waitForTimeout(1200); await stopRecord.click();
  const voicePreview = page.getByLabel('Recorded voice preview'); await expect(voicePreview).toBeVisible(); const voiceUrl = await voicePreview.getAttribute('src'); assert.ok(await play(voicePreview) > 0.5);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(voicePreview).toHaveCount(0);
  const audio = page.getByLabel('Voice message from You'); await expect(audio).toHaveAttribute('src', voiceUrl); assert.ok(await play(audio) > 0.5);
  assert.equal(await page.evaluate(url => window.__revoked.includes(url), voiceUrl), false);
  await record.click(); await expect(stopRecord).toBeVisible(); await page.waitForTimeout(300); await stopRecord.click(); await expect(voicePreview).toBeVisible(); const cancelled = await voicePreview.getAttribute('src');
  await page.getByRole('button', { name: 'Remove recorded voice', exact: true }).click(); await expect(voicePreview).toHaveCount(0);
  assert.equal(await page.evaluate(url => window.__revoked.includes(url), cancelled), true);
  await record.click(); await expect(stopRecord).toBeVisible(); await nav('Ava Morgan').click();
  await expect.poll(() => page.evaluate(() => window.__streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await nav('SecureBot').click(); await expect(voicePreview).toHaveCount(0);
  await page.evaluate(() => { const capture = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = async () => { navigator.mediaDevices.getUserMedia = capture; throw new DOMException('Denied by isolated test', 'NotAllowedError'); }; });
  await record.click(); await expect(page.getByRole('alert')).toContainText('Microphone access was blocked');
  passed('actual simulated recording, preview/sent playback, draft revocation, navigation cleanup and permission denial');
  await page.setViewportSize({ width: 390, height: 844 }); await expect(input()).toBeEnabled();
  await page.getByRole('button', { name: 'Insert emoji', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('searchbox', { name: 'Search emoji' })).toBeFocused(); await page.keyboard.press('Escape'); await expect(input()).toBeFocused();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'dark-mobile.png') });
  await page.getByRole('button', { name: 'Unmount chat', exact: true }).click();
  await expect.poll(() => page.evaluate(url => window.__revoked.includes(url), voiceUrl)).toBe(true);
  assert.deepEqual(errors, []); passed('mobile keyboard controls, dark theme, layout bounds and final voice URL cleanup without runtime errors');
  fs.writeFileSync(path.join(artifacts, 'evidence.json'), JSON.stringify({ passed: true, checks, runtimeErrors: errors.length }, null, 2));
})().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); }).finally(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  stop();
});
