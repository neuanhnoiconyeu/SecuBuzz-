/* Uses the existing local frontend/DATA pair. Never touches a DATA-owned DB. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const client = path.resolve(__dirname, '..');
const artifacts = path.join(client, 'artifacts/phase8-8-hotfix');
const temporary = path.join(client, 'tmp/profile-hotfix-' + crypto.randomUUID());
const origin = process.env.HOTFIX_FRONTEND_ORIGIN || 'http://localhost:3000';
const recordArgument = process.argv.indexOf('--backend-record');
if (recordArgument < 0 || !process.argv[recordArgument + 1]) throw new Error('Supply the existing owned local backend record with --backend-record.');
const recordPath = path.resolve(process.argv[recordArgument + 1]);
const isClientTemporary = filename => path.resolve(filename).toLowerCase().startsWith(path.join(client, 'tmp').toLowerCase() + path.sep);
if (!isClientTemporary(recordPath)) throw new Error('Backend ownership record must be under client/tmp.');
const initialRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
if (!isClientTemporary(initialRecord.database) || initialRecord.port !== 5000) throw new Error('Only the documented local port-5000 backend and client/tmp database are supported.');
const evidence = { startedAt: new Date().toISOString(), origin, checks: [], network: [], console: [], runtimeErrors: 0, screenshots: [] };
const clients = []; let browserProcess, browser, page, peer, currentBackend = initialRecord, paused = [], holdProfiles = false, backendStopped = false;
const password = crypto.randomBytes(30).toString('base64url');
const username = 'profilefix.' + Date.now().toString(36);
const peerName = 'profilepeer.' + Date.now().toString(36);
const verifyOnly = process.argv.includes('--verify-only');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, passed) { evidence.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw new Error(name); }
function save() { fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2)); }
function sanitizedBody(body) {
  try {
    const data = JSON.parse(body);
    if (typeof data.code === 'string') return { code: /^[A-Z_]{1,50}$/.test(data.code) ? data.code : '[redacted]', fields: [] };
    if (data.profile) return { profile: Object.fromEntries(Object.keys(data.profile).map(key => [key, key === 'isDemo' ? data.profile.isDemo : '[redacted]'])) };
    if (data.user) return { user: { id: '[redacted]', username: '[redacted]', isDemo: data.user.isDemo, keys: Object.keys(data.user) } };
    return { keys: Object.keys(data) };
  } catch { return { format: 'non-JSON', bytes: body.length }; }
}
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.pending = new Map(); this.id = 0; this.responses = new Map(); clients.push(this);
    this.ready = new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve); this.ws.addEventListener('error', reject); });
    this.ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.id) {
        const item = this.pending.get(packet.id); if (!item) return; this.pending.delete(packet.id); clearTimeout(item.timer);
        packet.error ? item.reject(new Error(packet.error.message)) : item.resolve(packet.result || {});
      } else if (packet.method === 'Runtime.exceptionThrown') evidence.runtimeErrors += 1;
      else if (packet.method === 'Network.responseReceived') {
        const response = packet.params.response; const url = new URL(response.url);
        if (url.pathname.startsWith('/api/')) {
          const item = { url: url.origin + url.pathname, path: url.pathname, method: this.methods?.get(packet.params.requestId) || 'GET', status: response.status };
          evidence.network.push(item); this.responses.set(packet.params.requestId, item);
        }
      } else if (packet.method === 'Network.requestWillBeSent') {
        this.methods ??= new Map(); this.methods.set(packet.params.requestId, packet.params.request.method);
      } else if (packet.method === 'Network.loadingFinished') {
        const item = this.responses.get(packet.params.requestId);
        if (item && ['/api/users/me', '/api/auth/me'].includes(item.path)) void this.send('Network.getResponseBody', { requestId: packet.params.requestId }).then(result => {
          item.body = sanitizedBody(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
        }).catch(() => {});
      } else if (packet.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(packet.params.type)) {
        // Capture browser diagnostic categories; never serialize arbitrary console arguments.
        evidence.console.push({ type: packet.params.type, captured: 'Console diagnostic arguments omitted to protect credentials.' });
      } else if (packet.method === 'Fetch.requestPaused') {
        if (holdProfiles) paused.push(packet.params.requestId);
        else void this.send('Fetch.continueRequest', { requestId: packet.params.requestId }).catch(() => {});
      }
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 25000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result?.value;
  }
}
async function wait(expression, label, target = page, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { try { if (await target.eval(`Boolean(${expression})`)) return; } catch {} await pause(100); }
  throw new Error('Timed out: ' + label);
}
async function input(selector, value, target = page) {
  await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, 'input', target);
  await target.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`); await pause(60);
}
async function click(text, root = 'body', target = page) {
  const expression = `[...document.querySelectorAll(${JSON.stringify(root + ' button')})].find(e => e.getBoundingClientRect().width && !e.disabled && (e.textContent.trim()===${JSON.stringify(text)} || e.getAttribute('aria-label')===${JSON.stringify(text)}))`;
  await wait(expression, 'button ' + text, target); await target.eval(`(${expression}).click()`); await pause(100);
}
async function navigate(route, target = page) { await target.send('Page.navigate', { url: origin + route }); await wait(`location.pathname===${JSON.stringify(route.split('#')[0])} && document.readyState==='complete'`, 'navigation', target); }
async function screenshot(name) { const image = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(artifacts, name), Buffer.from(image.data, 'base64')); evidence.screenshots.push(name); }
async function freePort() { const server=net.createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const value=server.address().port; await new Promise(resolve=>server.close(resolve)); return value; }
async function healthy(url) { for(let n=0;n<100;n++){try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)}); if(response.ok)return;}catch{} await pause(100);} throw new Error('Server did not become healthy'); }
async function stopBackend() {
  const pid = currentBackend.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned backend PID');
  const expected = path.join(client, '../DATA/server.js').replaceAll('/', '\\').replaceAll("'", "''");
  const statement = `$taskProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(-not $taskProcess -or -not $taskProcess.CommandLine.Contains('${expected}')){exit 2}; $taskListener=Get-NetTCPConnection -State Listen -LocalPort 5000; if($taskListener.OwningProcess -ne ${pid}){exit 3}`;
  execFileSync('powershell.exe',['-NoProfile','-Command',statement],{windowsHide:true,stdio:'ignore'});
  execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); backendStopped=true;
  for(let n=0;n<50;n++){try{await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(5000,'127.0.0.1',()=>server.close(resolve));});return;}catch{await pause(100);}}
  throw new Error('Owned backend port did not close');
}
async function startBackend() {
  const stamp=Date.now(); const out=fs.openSync(path.join(temporary,`backend-${stamp}.stdout.log`),'a'),err=fs.openSync(path.join(temporary,`backend-${stamp}.stderr.log`),'a');
  const child=spawn(process.execPath,[path.join(client,'../DATA/server.js')],{cwd:path.join(client,'../DATA'),windowsHide:true,detached:true,
    env:{...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:'5000',DB_PATH:initialRecord.database,AUTH_ALLOW_HTTP_LOCAL:'true',AUTH_ALLOWED_ORIGINS:'http://localhost:3000,http://127.0.0.1:3000',AUTH_TRUST_PROXY_IPS:'',AUTH_SESSION_TTL_SECONDS:'28800'},stdio:['ignore',out,err]});
  child.unref();fs.closeSync(out);fs.closeSync(err);currentBackend={pid:child.pid,port:5000,database:initialRecord.database,startedAt:new Date().toISOString()};
  fs.writeFileSync(recordPath,JSON.stringify(currentBackend,null,2)); await healthy('http://127.0.0.1:5000/healthz'); backendStopped=false;
}
async function newPage(debugOrigin) {
  const context=await browser.send('Target.createBrowserContext');const target=await browser.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});
  const pages=await(await fetch(debugOrigin+'/json/list')).json();const connection=new CDP(pages.find(p=>p.id===target.targetId).webSocketDebuggerUrl);
  for(const method of ['Page.enable','Runtime.enable','Network.enable'])await connection.send(method);
  await connection.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});return connection;
}
async function signup(name, target = page) {
  await navigate('/signup',target); await input('#auth-username',name,target); await input('#auth-email',name+'@example.test',target); await input('#auth-password',password,target); await input('#auth-confirm-password',password,target); await click('Create Account','body',target); await wait(`location.pathname==='/login'`,'explicit login after signup',target);
}
async function login(name = username, target = page, profileExpected = true) {
  await navigate('/login',target); await input('#auth-identifier',name,target);await input('#auth-password',password,target);await click('Sign In','body',target);await wait(`Boolean(document.querySelector('.real-messenger'))`,'authenticated workspace',target);
  if(profileExpected)await wait(`document.querySelector('.navigation-profile-name')?.textContent!=='Profile'`,'real profile',target);
}
async function openProfile() { await click('Your profile'); }
async function closeProfile() { await click('Close profile','.profile-dialog'); }
async function friends(tab, target = page) {
  await target.eval(`document.querySelector('.messenger-navigation-tabs button:nth-child(2)').click()`);
  const expression=`[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.startsWith(${JSON.stringify(tab)}))`;
  await wait(expression,'Friends tab',target);await target.eval(`(${expression}).click()`);await pause(150);
}
async function search(query,target = page) { await friends('Find Friends',target);await input('#friends-discovery','',target);await input('#friends-discovery',query,target);await wait(`document.querySelector('[aria-label="User search results"]')?.textContent.includes(${JSON.stringify(query)})`,'real discovery',target); }

async function run() {
  fs.mkdirSync(artifacts,{recursive:true});fs.mkdirSync(temporary,{recursive:true});const debugPort=await freePort();const debugOrigin=`http://127.0.0.1:${debugPort}`;
  browserProcess=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(temporary,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
  await healthy(debugOrigin+'/json/version');const version=await(await fetch(debugOrigin+'/json/version')).json();evidence.browser=version.Browser;browser=new CDP(version.webSocketDebuggerUrl);page=await newPage(debugOrigin);
  await signup(username);await login(username,page,false);await openProfile();
  if (verifyOnly) {
    await wait(`Boolean(document.querySelector('.profile-summary'))`, 'normal profile loading');
    check('Profile loads normally after real login without a connection error', !await page.eval(`Boolean(document.querySelector('.profile-dialog [role="alert"]'))`));
  } else {
  await wait(`document.querySelector('.profile-dialog [role="alert"]')?.textContent.includes('could not be reached')`,'reported connection failure');
  await pause(300);evidence.before=evidence.network.filter(item=>item.path==='/api/users/me'||item.path==='/api/auth/me');
  check('Reproduced healthy backend, successful auth and failed real Profile',evidence.before.some(item=>item.path==='/api/auth/me'&&item.status===200)&&evidence.before.some(item=>item.path==='/api/users/me'&&item.status===503&&item.body?.code==='FEATURE_UNAVAILABLE'));
  await click('Try again','.profile-dialog');await pause(400);check('Retry sends a new request but the old running backend still returns FEATURE_UNAVAILABLE',evidence.network.filter(item=>item.path==='/api/users/me'&&item.status===503).length>=2);
  await screenshot('before-profile-feature-unavailable.png');save();
  console.log('REPRODUCED. Waiting for repair command; original browser/session stays open.');
  const lines=readline.createInterface({input:process.stdin});const command=await new Promise(resolve=>lines.once('line',resolve));lines.close();
  if(command.trim()!=='repair')throw new Error('Expected repair command');
  await stopBackend();await startBackend();
  // Next dev may refresh after the focused frontend error-classification change.
  if(!await page.eval(`Boolean(document.querySelector('.profile-dialog[open]'))`))await openProfile();
  await click('Try again','.profile-dialog');await wait(`Boolean(document.querySelector('.profile-summary'))`,'same-session profile recovery');
  check('Restarting the existing DATA process restores Profile through Try again without another login',true);await screenshot('after-profile-recovered.png');
  }
  await click('Edit profile','.profile-dialog');await input('#profile-display-name','Hotfix Verified Profile');await input('#profile-status-message','Persisted hotfix verification');await click('Save changes','.profile-dialog');await wait(`document.querySelector('.profile-summary')?.textContent.includes('Hotfix Verified Profile')`,'confirmed edit');await closeProfile();await openProfile();
  check('Profile changes survive close/reopen',await page.eval(`document.querySelector('.profile-dialog')?.textContent.includes('Persisted hotfix verification')`));await closeProfile();
  await navigate('/');await wait(`document.querySelector('.navigation-profile-name')?.textContent==='Hotfix Verified Profile'`,'refresh/session restoration');await openProfile();check('Refresh restores the actual persisted profile',await page.eval(`document.querySelector('.profile-dialog')?.textContent.includes('Persisted hotfix verification')`));await closeProfile();
  await click('Sign out','.real-account-footer');await wait(`location.pathname==='/login'`,'logout');await login();await openProfile();check('Logout/login restores the actual profile',await page.eval(`document.querySelector('.profile-summary')?.textContent.includes('Hotfix Verified Profile')`));await closeProfile();
  // Hold only profile reads until the live backend has stopped, then let the genuine proxied request fail.
  await click('Sign out','.real-account-footer');await wait(`location.pathname==='/login'`,'logout before outage');holdProfiles=true;paused=[];await page.send('Fetch.enable',{patterns:[{urlPattern:'*/api/users/me',requestStage:'Request'}]});await login(username,page,false);
  for(let n=0;n<100&&!paused.length;n++)await pause(50);if(!paused.length)throw new Error('Profile request was not observed');
  await stopBackend();holdProfiles=false;for(const requestId of paused)await page.send('Fetch.continueRequest',{requestId});await page.send('Fetch.disable');await openProfile();await wait(`Boolean(document.querySelector('.profile-dialog [role="alert"]'))`,'temporary outage error');
  check('A genuine temporary backend outage shows an error while the valid session is retained',await page.eval(`Boolean(document.querySelector('.real-messenger'))`));await screenshot('temporary-outage.png');await startBackend();await click('Try again','.profile-dialog');await wait(`Boolean(document.querySelector('.profile-summary'))`,'retry recovery after outage');check('Try again recovers after backend return without another login',true);await closeProfile();
  peer=await newPage(debugOrigin);await signup(peerName,peer);await login(peerName,peer);
  await search(peerName);await click(`Add ${peerName} as a friend`);await wait(`document.querySelector('.friends-page')?.textContent.includes('Friend request sent.')`,'sent');
  await friends('Pending Requests',peer);await click('Refresh Friends','body',peer);await click('Accept request from Hotfix Verified Profile','body',peer);await wait(`document.querySelector('.friends-page')?.textContent.includes('Friend request accepted.')`,'accepted',peer);
  await friends('All Friends');await click('Refresh Friends');await wait(`document.querySelector('[aria-label="Your friends"]')?.textContent.includes(${JSON.stringify(peerName)})`,'friends list');check('Search, requests, acceptance and real Friends list remain operational',true);
  await click(`More actions for ${peerName}`);await click('Block user');await click('Block user','.friends-confirm-dialog');await friends('Blocked Users');await wait(`document.querySelector('[aria-label="Blocked users"]')?.textContent.includes(${JSON.stringify(peerName)})`,'blocked list');check('Real blocked users remain operational',true);await click(`Unblock ${peerName}`);await wait(`document.querySelector('.friends-page')?.textContent.includes('User unblocked.')`,'unblock');
  await click('Sign out','.real-account-footer');await wait(`location.pathname==='/login'`,'account switch logout');await login(peerName);await openProfile();
  check('Account switching never displays the previous private profile',!await page.eval(`document.querySelector('.profile-dialog')?.textContent.includes('Persisted hotfix verification')`));await screenshot('account-switch-profile.png');
  check('No unhandled browser runtime errors',evidence.runtimeErrors===0);
  evidence.after=evidence.network.filter(item=>item.path==='/api/users/me'&&item.status===200).slice(-5);
}
(async()=>{let failure;try{await run();}catch(error){failure=error;evidence.failure=error.message;console.error(error.message);if(page)try{await screenshot('failure.png');}catch{}}
  finally{if(backendStopped)try{await startBackend();}catch{evidence.backendRecoveryFailed=true;}if(browser)try{await browser.send('Browser.close');}catch{}for(const connection of clients)connection.ws.close();if(browserProcess?.pid&&browserProcess.exitCode===null)try{execFileSync('taskkill.exe',['/PID',String(browserProcess.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}evidence.passed=!failure;evidence.completedAt=new Date().toISOString();evidence.backend={port:5000,leftRunning:!backendStopped,databaseUnderClientTemporary:isClientTemporary(initialRecord.database)};save();console.log(`${evidence.checks.filter(item=>item.passed).length}/${evidence.checks.length} checks passed`);process.exitCode=failure?1:0;}
})();
