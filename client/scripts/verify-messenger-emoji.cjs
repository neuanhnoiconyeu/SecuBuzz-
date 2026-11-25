// Exercise actual client components and theme CSS without changing the running app or account data.
const path = require('node:path');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { build, stop } = require('../../server/node_modules/esbuild');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const artifacts = path.join(root, '.cache', 'phase5-emoji');
require('node:fs').mkdirSync(artifacts, { recursive: true });
let browser, server;
(async () => {
  const bundle = await build({ absWorkingDir: path.join(root, 'client'), tsconfig: 'tsconfig.json', bundle: true, write: false, outdir: 'out',
    platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/cursors/*'],
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' },
    stdin: { resolveDir: path.join(root, 'client'), loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import './src/styles/themes.css';
      import './src/styles/typography.css';
      import './src/styles/motion.css';
      import './src/app/globals.css';
      import { MessageComposer } from './src/components/messenger/MessageComposer';
      import { MessageList } from './src/components/messenger/MessageList';
      import { toggleMessageReaction, toggleMessagePin } from './src/messaging/messageState';
      const base = { conversationId: 'emoji-browser', senderId: 'peer', senderName: 'Peer', timestamp: new Date().toISOString(), type: 'text', deliveryStatus: 'delivered' };
      const seed = [{ ...base, id: 'original', content: 'Hello from SecuBuzz! Long messages and reactions stay within the conversation.', isPinned: true,
        reactions: [{ emoji: '👍', userIds: ['peer', 'self'] }] },
        { ...base, id: 'outgoing', senderId: 'self', senderName: 'You', content: '👩🏽‍💻', isEdited: true, forwardedFrom: 'Friend',
          replyTo: { messageId: 'original', senderName: 'Peer', contentSnippet: 'Hello from SecuBuzz!' },
          reactions: ['👍','❤️','😂','😮','😢','😡','🔥','🍕','🚀','🎉','🌈','🌷'].map((emoji, index) => ({ emoji, userIds: ['user' + index] })) },
        { ...base, id: 'voice', senderId: 'self', senderName: 'You', type: 'voice', content: '', voice: { audioUrl: '', durationSeconds: 4 } }];
      function App() {
        const [messages, setMessages] = useState(seed);
        return <main className="chat-window" style={{ height: '100dvh' }}>
          <MessageList currentUserId="self" messages={messages} onRetryMessage={() => {}} onReplyMessage={() => {}}
            onEditMessage={(id, content) => { setMessages(old => old.map(m => m.id === id ? { ...m, content, isEdited: true } : m)); return true; }}
            onDeleteMessage={id => { setMessages(old => old.filter(m => m.id !== id)); return true; }}
            onTogglePin={id => setMessages(old => toggleMessagePin({ 'emoji-browser': old }, 'emoji-browser', id)['emoji-browser'])}
            onToggleReaction={(id, emoji) => setMessages(old => toggleMessageReaction({ 'emoji-browser': old }, 'emoji-browser', id, emoji, 'self')['emoji-browser'])} />
          <MessageComposer conversationName="Peer" messageCount={messages.length} isSending={false} buzzBusy={false}
            onSend={async content => { setMessages(old => [...old, { ...base, id: crypto.randomUUID(), senderId: 'self', senderName: 'You', content }]); return true; }}/>
        </main>;
      }
      createRoot(document.getElementById('root')!).render(<App/>);
    ` } });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/app.js' ? 'application/javascript' : request.url === '/app.css' ? 'text/css' : 'text/html');
    response.end(request.url === '/app.js' ? js : request.url === '/app.css' ? css : '<!doctype html><html data-theme="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{box-sizing:border-box}body{margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}button,input,textarea{font:inherit}</style><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 640 }, { width: 375, height: 500 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const voiceBubble = await page.locator('[data-message-id="voice"] .message-bubble').boundingBox();
    const audioBox = await page.getByLabel('Voice message from You').boundingBox();
    assert.ok(audioBox.x >= voiceBubble.x && audioBox.x + audioBox.width <= voiceBubble.x + voiceBubble.width, 'voice playback fits the message bubble: ' + JSON.stringify({ voiceBubble, audioBox }));
    assert.equal(await page.getByLabel('Voice message from You').evaluate(audio => {
      const range = document.createRange(); range.selectNodeContents(audio.nextElementSibling);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    }), 1, 'voice duration stays on one line at phone widths');
    const checkBounds = async locator => {
      const box = await locator.boundingBox();
      const bounds = await page.evaluate(() => ({ width: visualViewport.width, height: visualViewport.height }));
      assert.ok(box && box.x >= 7 && box.y >= 7 && box.x + box.width <= bounds.width - 7 && box.y + box.height <= bounds.height - 7, JSON.stringify({ box, bounds }));
      assert.equal(await locator.evaluate(node => node.matches(':popover-open')), true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, 'no horizontal document overflow');
      const grid = locator.locator('.emoji-picker-grid');
      if (await grid.count()) {
        const gridBox = await grid.boundingBox();
        assert.ok(gridBox.y + gridBox.height <= box.y + box.height + 1, 'emoji results fit inside the popup');
      }
    };
    const input = page.getByRole('textbox', { name: 'Message to Peer' });
    await input.fill('Hello brave world\nSecond line'); await input.evaluate(node => node.setSelectionRange(6, 11));
    await page.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    let panel = page.getByRole('dialog', { name: 'Emoji picker', exact: true }); await checkBounds(panel);
    await expect(page.getByRole('searchbox', { name: 'Search emoji' })).toBeFocused();
    await page.getByRole('tab', { name: 'People', exact: true }).click();
    assert.ok(await panel.locator('[data-emoji]').count() > 1500);
    assert.equal(await panel.locator('.emoji-picker-grid').evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight > 40), true);
    await page.getByRole('searchbox', { name: 'Search emoji' }).fill('pizza');
    await page.getByRole('searchbox', { name: 'Search emoji' }).press('Enter');
    await expect(input).toHaveValue('Hello brave world\nSecond line'); await expect(panel).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search emoji' }).press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Insert pizza 🍕', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(input).toHaveValue('Hello 🍕 world\nSecond line');
    await expect(input).toBeFocused(); assert.equal(await input.evaluate(node => node.selectionStart), 8);
    await page.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Recently Used', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Insert pizza 🍕', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(input).toBeFocused();
    const incoming = page.locator('[data-message-id="original"]');
    await incoming.hover(); await incoming.getByRole('button', { name: 'React to message', exact: true }).click();
    await checkBounds(page.getByRole('menu', { name: 'Choose a reaction', exact: true }));
    await page.getByRole('menuitem', { name: 'More reactions', exact: true }).click();
    panel = page.getByRole('dialog', { name: 'Choose a reaction', exact: true }); await checkBounds(panel);
    await page.getByRole('searchbox', { name: 'Search emoji' }).fill('fire');
    await page.getByRole('button', { name: 'React with fire 🔥', exact: true }).click();
    await expect(incoming.getByRole('button', { name: '👍 1', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(incoming.getByRole('button', { name: '🔥 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await incoming.getByRole('button', { name: '🔥 1', exact: true }).click();
    await expect(incoming.getByRole('button', { name: '🔥 1', exact: true })).toHaveCount(0);
    // Keyboard-triggered menu and picker transitions should never overlap.
    await incoming.getByRole('button', { name: 'More actions', exact: true }).focus(); await page.keyboard.press('Enter');
    await checkBounds(page.getByRole('menu', { name: 'Message actions', exact: true }));
    await page.getByRole('button', { name: 'Insert emoji', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0);
    panel = page.getByRole('dialog', { name: 'Emoji picker', exact: true }); await checkBounds(panel);
    // The picker stays in view when the mobile keyboard reduces the viewport.
    if (viewport.width < 500) { await page.setViewportSize({ width: viewport.width, height: 350 }); await checkBounds(panel); }
    await page.screenshot({ path: path.join(artifacts, 'phase5-emoji-' + viewport.width + '.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-message-id="outgoing"] .message-text--emoji')).toHaveCount(1);
    const badges = page.locator('[data-message-id="outgoing"] .rx-summary');
    const wrap = page.locator('[data-message-id="outgoing"] .msg-bubble-wrap');
    const badgeBox = await badges.boundingBox(), wrapBox = await wrap.boundingBox();
    assert.ok(badgeBox.x >= wrapBox.x - 1 && badgeBox.x + badgeBox.width <= wrapBox.x + wrapBox.width + 1);
    const bubbleBox = await page.locator('[data-message-id="outgoing"] .message-bubble').boundingBox();
    assert.ok(Math.abs(bubbleBox.x + bubbleBox.width - wrapBox.x - wrapBox.width) < 1, 'outgoing bubbles stay aligned when reactions are wider');
    assert.deepEqual(errors, []); console.log('PASS ' + viewport.width + 'x' + viewport.height + ': native popover bounds, keyboard/cursor, recents, reaction replacement/removal, menus and wrapped badges');
    await page.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  stop();
});
