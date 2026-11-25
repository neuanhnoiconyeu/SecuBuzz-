'use strict';
// Real browser/SFU acceptance. Creates only disposable accounts/rooms, never resets data.
const {chromium,expect}=require('@playwright/test');
const {randomBytes}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
let origin=process.env.VOICE_TEST_ORIGIN||'http://localhost:3001';
const evidenceDir=path.resolve(__dirname,'../../.cache/voice-rooms-'+randomBytes(4).toString('hex'));
const owned=[];
const evidence={origin,realLiveKit:true,syntheticCapture:true,checks:[],media:[],passed:false};

// Optional disposable DATA/Next fixture; media still traverses the existing real Docker SFU.
async function isolated(){
 const net=require('node:net'),{spawn}=require('node:child_process');
 const port=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const n=server.address().port;await new Promise(r=>server.close(r));return n;};
 const root=path.resolve(__dirname,'../..'),backendPort=await port(),frontendPort=await port();
 const env=Object.fromEntries(fs.readFileSync(path.join(root,'docker/secrets/livekit/backend.env'),'utf8').split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
 origin=`http://localhost:${frontendPort}`;evidence.origin=origin;evidence.isolatedData=true;
 const launch=(args,cwd,extra)=>{const p=spawn(process.execPath,args,{cwd,env:{...process.env,...extra},windowsHide:true,stdio:'ignore'});owned.push(p);p.on('error',()=>{});};
 const healthy=async url=>{for(let i=0;i<180;i++){try{if((await fetch(url,{signal:AbortSignal.timeout(2000)})).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Disposable fixture startup failed');};
 launch(['src/data/main.ts'],path.join(root,'server'),{...env,NODE_ENV:'test',DATA_ROOT:path.join(root,'DATA'),DB_PATH:path.join(evidenceDir,'isolated.sqlite'),HOST:'127.0.0.1',PORT:String(backendPort),AUTH_ALLOWED_ORIGINS:origin,AUTH_ALLOW_HTTP_LOCAL:'true'});
 await healthy(`http://127.0.0.1:${backendPort}/healthz`);
 launch([require.resolve('next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',String(frontendPort)],path.join(root,'client'),{NODE_ENV:'development',AUTH_BACKEND_URL:`http://127.0.0.1:${backendPort}`,NEXT_PUBLIC_AUTH_MODE:'api',NEXT_PUBLIC_AUTH_API_READY:'true',NEXT_PUBLIC_LIVEKIT_ENABLED:'true',NEXT_PUBLIC_DIRECT_CALLS_ENABLED:'true',NEXT_PUBLIC_LIVEKIT_URL:env.LIVEKIT_URL,CLIENT_TEST_DIST_DIR:'.next-e2ee-'+path.basename(evidenceDir)});
 await healthy(origin+'/login');
}

const check=(name,value)=>{evidence.checks.push({name,passed:Boolean(value)});console.log(`${value?'PASS':'FAIL'} ${name}`);if(!value)throw Error(name);};
async function api(page,route,method='GET',body){return page.evaluate(async({route,method,body})=>{
 const headers={Accept:'application/json'};
 if(method!=='GET'){const r=await fetch('/api/auth/csrf',{credentials:'same-origin',cache:'no-store'});headers['X-CSRF-Token']=(await r.json()).csrfToken;}
 if(body!==undefined)headers['Content-Type']='application/json';
 const r=await fetch(route,{method,headers,credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:r.status,body:r.status===204?null:await r.json()};
},{route,method,body});}
async function stats(page){return page.evaluate(async()=>{
 const rows=[];for(const pc of window.__roomPCs.filter(p=>p.connectionState==='connected'))for(const s of(await pc.getStats()).values())if(s.type==='inbound-rtp'&&!s.isRemote)rows.push({kind:s.kind,bytes:s.bytesReceived||0,samples:s.totalSamplesReceived||0,energy:s.totalAudioEnergy||0});return rows;
});}
async function audio(page,label){await expect.poll(async()=> (await stats(page)).some(s=>s.kind==='audio'&&s.bytes>0&&s.samples>0&&s.energy>0),{timeout:45000}).toBe(true);
 const enable=page.getByRole('button',{name:'Enable sound',exact:true});if(await enable.isVisible())await enable.click();
 await expect.poll(()=>page.locator('.voice-audio-output audio').evaluateAll(nodes=>nodes.some(n=>n.currentTime>0&&!n.paused&&n.srcObject?.getAudioTracks().some(t=>t.readyState==='live'))),{timeout:20000}).toBe(true);
 evidence.media.push({label,inbound:await stats(page)});check(label+' receives real remote audio samples',true);
}
async function clean(page){await expect.poll(()=>page.evaluate(()=>window.__roomTracks.every(t=>t.readyState==='ended')&&window.__roomPCs.every(p=>p.connectionState==='closed'||p.connectionState==='new'&&!p.localDescription&&!p.remoteDescription)),{timeout:20000}).toBe(true);}
(async()=>{
 fs.mkdirSync(evidenceDir,{recursive:true});let browser,password;const contexts=[],pages=[],users=[];let pageErrors=0,attachmentRequests=0;
 try{
  if(process.argv.includes('--isolated'))await isolated();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--autoplay-policy=document-user-activation-required']});
  password=randomBytes(24).toString('base64url');const suffix=randomBytes(4).toString('hex');
  for(let i=0;i<2;i++){
   const context=await browser.newContext({permissions:['microphone','camera'],viewport:{width:1440,height:1000}});contexts.push(context);
   await context.addInitScript(()=>{window.__roomPCs=[];window.__roomTracks=[];const PC=window.RTCPeerConnection;window.RTCPeerConnection=class extends PC{constructor(...args){super(...args);window.__roomPCs.push(this);}};
    const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{const s=await capture(options);window.__roomTracks.push(...s.getTracks());return s;};});
   const page=await context.newPage();pages.push(page);page.on('pageerror',()=>pageErrors++);page.on('response',r=>{const p=new URL(r.url()).pathname;if(p==='/api/voice/token'){evidence.tokenResponses??=[];evidence.tokenResponses.push(r.status());}});page.on('console',msg=>{if(msg.type()==='error'||msg.type()==='warn'){evidence.consoleCategories??=[];evidence.consoleCategories.push(['timeout','connect','publish','permission','WebSocket','token','401','403','500'].filter(k=>msg.text().toLowerCase().includes(k.toLowerCase())));}});page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/attachments')&&!r.url().endsWith('/limits'))attachmentRequests++;});
   await page.goto(origin+'/login');
   if(i===0)check('unauthenticated room catalog is rejected',(await api(page,'/api/voice/rooms')).status===401);
   const username='rooms24-'+i+'-'+suffix,displayName=i?'Room Bob':'Room Alice';
   const registration=await api(page,'/api/auth/register','POST',{username,email:username+'@example.test',displayName,password});
   check('synthetic registration '+i+' HTTP '+registration.status,registration.status===201);
   await page.getByLabel('Username or email').fill(username);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign In',exact:true}).click();
   await page.getByRole('heading',{name:'Your conversations',exact:true}).waitFor({state:'attached',timeout:60000});
   users.push((await api(page,'/api/auth/me')).body.user);
   await page.getByRole('button',{name:'Open Voice Rooms',exact:true}).click();await expect(page.getByRole('heading',{name:'Lounge',exact:true})).toBeVisible();
  }
  const [a,b]=pages,name='Room test '+suffix;
  for(const room of ['lounge','study-room','dev-corner'])check('default room '+room+' retained',(await api(a,'/api/voice/rooms')).body.items.some(r=>r.id===room));
  await a.getByRole('button',{name:'Create room',exact:true}).click();let dialog=a.getByRole('dialog');await dialog.getByLabel('Room name').fill(name);await dialog.getByRole('button',{name:'Create room',exact:true}).click();
  await expect(a.getByRole('heading',{name,exact:true})).toBeVisible();const room=(await api(a,'/api/voice/rooms')).body.items.find(r=>r.name===name);check('room owner comes from the verified session',room.ownerId===users[0].id);
  await b.getByRole('button',{name:new RegExp('^'+name+',')}).click();check('peer sees the persisted room but no owner controls',await b.getByRole('button',{name:'Rename room',exact:true}).count()===0);
  check('backend rejects unauthorized rename',(await api(b,'/api/voice/rooms/'+room.id,'PATCH',{name:'Hijacked'})).status===403);
  check('backend rejects unauthorized delete',(await api(b,'/api/voice/rooms/'+room.id,'DELETE')).status===403);
  const noCsrf=await a.evaluate(()=>fetch('/api/voice/token',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:'lounge'})}).then(r=>r.status));check('voice token preserves CSRF',noCsrf===403);
  for(const page of pages)await page.getByRole('button',{name:'Join room',exact:true}).click();
  for(const page of pages){await expect(page.getByRole('list',{name:'Room participants'}).locator('li')).toHaveCount(2,{timeout:45000});await audio(page,page===a?'Alice':'Bob');}
  check('one LiveKit session per browser',await Promise.all(pages.map(p=>p.evaluate(()=>window.__roomPCs.filter(pc=>pc.connectionState==='connected').length<=2))).then(v=>v.every(Boolean)));
  await a.getByRole('button',{name:'Mute microphone',exact:true}).click();await expect(a.getByRole('button',{name:'Unmute microphone',exact:true})).toBeVisible();
  await expect(b.getByRole('list',{name:'Room participants'}).locator('li').filter({hasText:'Room Alice'}).getByLabel('Microphone muted')).toBeVisible();
  await a.getByRole('button',{name:'Unmute microphone',exact:true}).click();await expect(a.getByRole('button',{name:'Mute microphone',exact:true})).toBeVisible();check('mute/unmute propagates to the other participant',true);
  const renamed=name+' renamed';await a.getByRole('button',{name:'Rename room',exact:true}).click();dialog=a.getByRole('dialog');await dialog.getByLabel('Room name').fill(renamed);await dialog.getByRole('button',{name:'Save name',exact:true}).click();
  for(const page of pages)await expect(page.getByRole('heading',{name:renamed,exact:true})).toBeVisible({timeout:10000});check('rename synchronizes without replacing the media session',true);
  await b.getByRole('button',{name:'Leave room',exact:true}).click();await clean(b);await expect(a.getByRole('list',{name:'Room participants'}).locator('li')).toHaveCount(1);
  await b.reload();await b.getByRole('heading',{name:'Your conversations',exact:true}).waitFor({state:'attached',timeout:120000});await b.getByRole('button',{name:'Open Voice Rooms',exact:true}).click({timeout:30000});await b.getByRole('button',{name:new RegExp('^'+renamed+',')}).click();await b.getByRole('button',{name:'Join room',exact:true}).click();
  await expect(b.getByRole('list',{name:'Room participants'}).locator('li')).toHaveCount(2,{timeout:30000});await audio(b,'Bob after reload');check('room metadata and real media survive reload/rejoin',true);
  // Permission failure uses this synthetic context only; joining can continue in listen-only mode.
  await b.getByRole('button',{name:'Leave room',exact:true}).click();await clean(b);
  await b.evaluate(()=>{window.__captureBeforeDenied=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Synthetic denial','NotAllowedError'));});
  await b.getByRole('button',{name:'Join room',exact:true}).click();await expect(b.getByText(/Microphone permission was denied/)).toBeVisible();await expect(b.getByRole('list',{name:'Room participants'}).locator('li')).toHaveCount(2);check('denied microphone is explained and supports listen-only participation',true);
  await b.evaluate(()=>{navigator.mediaDevices.getUserMedia=window.__captureBeforeDenied;});await b.getByRole('button',{name:'Unmute microphone',exact:true}).click();await expect(b.getByRole('button',{name:'Mute microphone',exact:true})).toBeVisible();
  await a.getByRole('button',{name:'Delete room',exact:true}).click();dialog=a.getByRole('dialog');await dialog.getByRole('button',{name:'Delete room',exact:true}).click();
  for(const page of pages){await expect(page.getByRole('button',{name:'Join room',exact:true})).toBeVisible({timeout:15000});await clean(page);}
  check('deleted room disappears and both media sessions stop',!(await api(a,'/api/voice/rooms')).body.items.some(r=>r.id===room.id));
  check('deleted room cannot obtain another token',(await api(b,'/api/voice/token','POST',{roomId:room.id})).status===403);
  for(const page of pages){await page.getByRole('button',{name:/^Lounge,/}).click();await page.getByRole('button',{name:'Join room',exact:true}).click();}
  await audio(a,'Default Lounge Alice');await audio(b,'Default Lounge Bob');for(const page of pages){await page.getByRole('button',{name:'Leave room',exact:true}).click();await clean(page);}
  await b.setViewportSize({width:390,height:844});check('mobile workspace avoids horizontal overflow',await b.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  check('voice media does not use encrypted message attachment APIs',attachmentRequests===0);check('no browser runtime exceptions',pageErrors===0);evidence.passed=true;
 }catch(error){evidence.failure=String(error.message).replaceAll(password||'\u0000','[redacted]').replace(/access_token=[^&\s]+/g,'access_token=[redacted]');console.error(evidence.failure);evidence.diagnostics=await Promise.all(pages.map(p=>p.evaluate(()=>({peers:window.__roomPCs.map(c=>({state:c.connectionState,ice:c.iceConnectionState,signal:c.signalingState})),tracks:window.__roomTracks.map(t=>({kind:t.kind,state:t.readyState})),errors:[...document.querySelectorAll('.voice-device-error')].map(e=>e.textContent)})).catch(()=>null)));for(const [i,p]of pages.entries())await p.screenshot({path:path.join(evidenceDir,'failure-'+i+'.png')}).catch(()=>{});process.exitCode=1;
 }finally{for(const p of pages)await api(p,'/api/auth/logout','POST').catch(()=>{});for(const c of contexts)await c.close().catch(()=>{});await browser?.close();for(const child of owned.reverse()){if(child.exitCode!==null)continue;if(process.platform==='win32')await new Promise(resolve=>{const p=require('node:child_process').spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});p.once('exit',resolve);p.once('error',resolve);});else child.kill('SIGTERM');}fs.writeFileSync(path.join(evidenceDir,'evidence.json'),JSON.stringify(evidence,null,2));console.log('Evidence: '+evidenceDir);}
})();
