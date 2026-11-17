const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const { spawn }=require('node:child_process');
const { once }=require('node:events');
const { openDatabase }=require('../../server/database/connection');
const { startServer }=require('../../server/start');
const { loadAuthConfig }=require('../../server/auth/config');
const PASSWORD='Synthetic passphrase for auth tests 2026!';
const ORIGIN='http://localhost:3000';
const envDefaults={NODE_ENV:'test',AUTH_ALLOW_HTTP_LOCAL:'true',AUTH_ALLOWED_ORIGINS:ORIGIN,HOST:'127.0.0.1',PORT:'0'};
class Browser {
    constructor(origin,sourceOrigin=ORIGIN) { this.origin=origin;this.sourceOrigin=sourceOrigin;this.cookies=new Map(); }
    clone() { const copy=new Browser(this.origin,this.sourceOrigin);copy.cookies=new Map(this.cookies);return copy; }
    async request(url,{method='GET',body,rawBody,headers={}}={}) {
        const requestHeaders={Origin:this.sourceOrigin,...(this.cookies.size ? {Cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ')} : {}),
            ...(body!==undefined || rawBody!==undefined ? {'Content-Type':'application/json'} : {}),...headers};
        const response=await fetch(this.origin+url,{method,headers:requestHeaders,
            body:rawBody ?? (body===undefined ? undefined : JSON.stringify(body)),redirect:'manual'});
        const setCookies=response.headers.getSetCookie();
        for (const cookie of setCookies) {
            const pair=cookie.split(';',1)[0];const index=pair.indexOf('=');const key=pair.slice(0,index);const value=pair.slice(index+1);
            if (value) this.cookies.set(key,value);else this.cookies.delete(key);
        }
        const text=await response.text();
        let json=null; try {json=text ? JSON.parse(text) : null;} catch {json={invalidJson:true};}
        return {status:response.status,body:json,headers:response.headers,setCookies,text};
    }
    async csrf() { const response=await this.request('/api/auth/csrf');if(response.status!==200) throw new Error('CSRF fixture bootstrap failed');return response.body.csrfToken; }
    async post(url,body,token) { return this.request(url,{method:'POST',body,headers:{'X-CSRF-Token':token ?? await this.csrf()}}); }
    async register(username='fixture-user',overrides={}) { return this.post('/api/auth/register',{username,email:`${username}@example.test`,password:PASSWORD,displayName:'Fixture User',...overrides}); }
    async login(identifier='fixture-user',password=PASSWORD) { return this.post('/api/auth/login',{identifier,password}); }
}
async function setup(t,{env={},...dependencies}={}) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'secubuzz-db2-'));
    const filename=path.join(directory,'auth.sqlite');
    const connections=[];const applications=[];const children=[];
    t.after(async()=>{
        for (const child of children) if(child.exitCode===null && child.signalCode===null) {const exited=once(child,'exit');child.kill();await exited;}
        for (const application of applications.reverse()) if(application.server.listening) await application.close();
        for (const connection of connections.reverse()) if(connection.open) connection.close();
        for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory,name));
        fs.rmdirSync(directory);
    });
    const db=openDatabase({filename});connections.push(db);
    const configuration=loadAuthConfig({...envDefaults,...env});
    const application=await startServer({db,config:configuration,env:{...envDefaults,...env},...dependencies});applications.push(application);
    const url=`http://127.0.0.1:${application.server.address().port}`;
    return {db,filename,directory,connections,applications,children,application,config:configuration,
        browser:()=>new Browser(url,configuration.origins[0]),
        async anotherServer() {
            const connection=openDatabase({filename});connections.push(connection);
            const other=await startServer({db:connection,config:configuration,env:envDefaults,...dependencies});applications.push(other);
            return new Browser(`http://127.0.0.1:${other.server.address().port}`,configuration.origins[0]);
        }};
}
async function childBackend(fixture) {
    const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'../..'),env:{...process.env,...envDefaults,DB_PATH:fixture.filename},stdio:['ignore','pipe','pipe']});
    fixture.children.push(child);
    const port=await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>{child.kill();reject(new Error('Backend startup timed out'));},10000);
        let output='';
        child.stdout.on('data',chunk=>{output+=chunk.toString();const match=/listening on port (\d+)/.exec(output);if(match){clearTimeout(timeout);resolve(Number(match[1]));}});
        child.once('error',()=>{clearTimeout(timeout);reject(new Error('Backend process failed to start'));});
        child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Backend exited before listening'));});
        child.stderr.on('data',()=>{});
    });
    return {child,browser:new Browser(`http://127.0.0.1:${port}`),async stop(){const exited=once(child,'exit');child.kill();await exited;}};
}
module.exports={setup,Browser,childBackend,PASSWORD,ORIGIN,envDefaults};
