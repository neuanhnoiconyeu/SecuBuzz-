const { test } = require('node:test');
const assert = require('node:assert/strict');
const { temporary } = require('./support/database');
const path = require('node:path');

test('existing Express user/contact/message/log endpoints and audit report stay compatible', async t => {
    const directory = temporary(t, () => { if (db?.open) db.close(); });
    process.env.DB_PATH = path.join(directory,'routes.sqlite');
    const db = require('../server/database/db');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/users',require('../server/routes/users'));
    app.use('/api/messages',require('../server/routes/messages'));
    app.use('/api/logs',require('../server/routes/logs'));
    const server = app.listen(0,'127.0.0.1');
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    async function request(method,url,body) {
        const response=await fetch(origin+url,{method,headers:{'content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
        return {status:response.status,body:await response.json()};
    }
    try {
        const a=await request('POST','/api/users',{username:'route-a',display_name:'Route A'});
        const b=await request('POST','/api/users',{username:'route-b',display_name:'Route B'});
        assert.equal(a.status,201); assert.equal(b.status,201);
        assert.equal((await request('GET',`/api/users/${a.body.user_id}`)).body.username,'route-a');
        assert.equal((await request('GET','/api/users')).body.length,2);
        assert.equal((await request('PATCH',`/api/users/${a.body.user_id}/status`,{status:'online'})).status,200);
        assert.equal((await request('POST',`/api/users/${a.body.user_id}/contacts`,{friend_id:b.body.user_id})).status,201);
        assert.equal((await request('GET',`/api/users/${a.body.user_id}/contacts`)).body[0].contact_status,'pending');
        const sent=await request('POST','/api/messages',{sender_id:a.body.user_id,receiver_id:b.body.user_id,ciphertext:'encrypted-route-payload',iv:'route-iv'});
        assert.equal(sent.status,201);
        const id=sent.body.data.message_id;
        assert.equal((await request('GET',`/api/messages/${id}`)).body.ciphertext,'encrypted-route-payload');
        assert.equal((await request('GET',`/api/messages/conversation/${a.body.user_id}/${b.body.user_id}`)).body.count,1);
        assert.equal((await request('PATCH',`/api/messages/${id}/status`,{status:'read'})).status,200);
        const logged=await request('POST','/api/logs',{user_id:a.body.user_id,event_type:'route.test',severity:'CRITICAL',source:'auditor_bot',description:'Test event',details:{test:true}});
        assert.equal(logged.status,201);
        assert.equal((await request('GET','/api/logs/critical')).body.logs.length,1);
        assert.equal((await request('GET','/api/logs/report')).body.summary.total_events,1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM AuditLogs').get().n,1);
    } finally {
        await new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));
    }
});
