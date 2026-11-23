'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GROUP_ROUTES}=require('../server/routes/groups');
const {CONTRACT,assertContractRoutes,assertContractResponse,assertGroupResponse,Browser}=require('./support/contract');
const {validateExample}=require('./support/schema-check');
const {httpGroupFixture,actorRequest,snapshot,changedTables,createClock,assertSecurityHeaders}=require('./support/groups');
const {forAll}=require('./support/random');

test('T-5C-21: independent contract covers every frozen route and rejects drift',()=>{
    assertContractRoutes(GROUP_ROUTES);
    assert.throws(()=>assertContractRoutes(GROUP_ROUTES.slice(1)));
    assert.throws(()=>assertContractRoutes([...GROUP_ROUTES,{id:'G99',method:'GET',path:'/unexpected'}]));
    for(const row of CONTRACT) {
        assert.ok(Object.isFrozen(row));
        for(const status of row.success)assertContractResponse(row.id,{status});
        for(const[status,code]of row.errors)assertContractResponse(row.id,{status,body:{code,fields:[]}});
        assert.throws(()=>assertContractResponse(row.id,{status:418,body:{code:'UNLISTED'}}));
        assert.throws(()=>assertContractResponse(row.id,{status:400,body:{code:'UNLISTED'}}));
        assert.throws(()=>assertContractResponse(row.id,{status:299}));
        assert.ok(['any','self','invitee'].includes(row.scope));
    }
    const create=CONTRACT.find(x=>x.id==='G01'),patch=CONTRACT.find(x=>x.id==='G04');
    assert.deepEqual(create.requestFields,['name','description','historyPolicy','idempotencyKey']);
    assert.ok(!patch.requestFields.includes('historyPolicy'));
    assert.ok(create.validationFields.includes('historyPolicy')&&patch.validationFields.includes('historyPolicy'));
    assert.deepEqual(create.fieldErrors.historyPolicy,[[400,'VALIDATION_ERROR']]);
    assert.deepEqual(patch.fieldErrors.historyPolicy,[[400,'VALIDATION_ERROR']]);
});

test('T-5C-21: real HTTP response status/code pairs belong to their route contract',async t=>{
    const f=await httpGroupFixture(t,{features:{groupApi:true,groups:{maxMembers:10,
        maxPendingInvitationsPerGroup:20,maxPendingInvitationsPerInvitee:20}}});
    for(const row of CONTRACT) {
        const url='/api/groups'+row.path.replace(':id',f.groupId).replace(':userId',f.actors.member.id)
            .replace(':invitationId',f.invitationId);
        const unauthenticated=await actorRequest(f.actors.unauthenticated,row.method,url);
        assert.equal(unauthenticated.status,401,row.id);assertContractResponse(row.id,unauthenticated);
        const denied=await actorRequest(f.actors.nonMember,row.method,url,{body:row.requestFields.length?{}:undefined});
        assertContractResponse(row.id,denied);
    }
    const invalid=await actorRequest(f.actors.owner,'PATCH',`/api/groups/${f.groupId}`,{body:{historyPolicy:'all'}});
    assertContractResponse('G04',invalid);assert.equal(invalid.status,400);assert.deepEqual(invalid.body.fields,['historyPolicy']);
});

test('T-5C-21: schema checker enforces the supported vocabulary and local references',()=>{
    const root={components:{schemas:{Item:{type:'object',required:['id'],additionalProperties:false,
        properties:{id:{type:'integer',minimum:1,maximum:9},label:{type:['string','null'],minLength:1,maxLength:3,pattern:'^[a-z]+$'}}}}}};
    const schema={type:'array',maxItems:2,items:{$ref:'#/components/schemas/Item'}};
    assert.equal(validateExample([{id:1,label:'abc'}],schema,root),true);
    for(const value of [[{id:0}],[{id:10}],[{id:1,extra:true}],[{label:'x'}],[{id:1,label:'AB'}],[{id:1,label:'abcd'}],{}])
        assert.throws(()=>validateExample(value,schema,root));
    assert.throws(()=>validateExample({}, {type:'object',properties:{absent:{typo:true}}}));
    assert.throws(()=>validateExample({},{$ref:'#/missing'},root));
    assert.throws(()=>validateExample('bad',{type:'string',format:'date-time'}));
    assert.equal(validateExample('2026-01-01T00:00:00Z',{type:'string',format:'date-time'}),true);
    assert.throws(()=>validateExample('no',{enum:['yes']}));
    assert.throws(()=>validateExample(false,{const:true}));
    assert.throws(()=>validateExample([{id:1},{id:1}],{type:'array',uniqueItems:true}));
    assert.equal(validateExample([{id:1},{id:2}],{type:'array',uniqueItems:true}),true);
    assert.throws(()=>validateExample(3,{oneOf:[{type:'number'},{type:'integer'}]}));
    assert.equal(validateExample('x',{oneOf:[{type:'string'},{type:'integer'}]}),true);
});

test('T-5C-21: HTTP helper rejects response drift, including direct and cloned browser calls',async t=>{
    const http=require('node:http');
    const server=http.createServer((req,res)=>{res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'UNLISTED',fields:[]}));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    const browser=new Browser(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(browser.request('/api/groups?limit=1'),/undocumented error/);
    await assert.rejects(browser.clone().request('/api/groups/feature-status'),/undocumented error/);
    await assert.rejects(browser.post('/api/groups',{name:'valid'},'proof'),/undocumented error/);
    assert.throws(()=>assertGroupResponse('GET','/api/groups/unlisted/path',{status:200}),/unmatched/);
    assert.throws(()=>assertGroupResponse('GET','/api/groups',{status:404,body:{code:'NOT_FOUND'}}),/undocumented error/);
    assertGroupResponse('POST','/api/groups/id/unarchive',{status:404,body:{code:'NOT_FOUND'}});
    assertGroupResponse('HEAD','/api/groups',{status:401,body:null});
    assertGroupResponse('GET','/api/groups?limit=1',{status:200});
    assertGroupResponse('GET','/api/groups-extra',{status:418});
});

test('T-5C-21: schema vocabulary covers the existing OpenAPI documents',()=>{
    const fs=require('node:fs'),path=require('node:path');
    const {checkVocabulary}=require('./support/schema-check');
    let schemas=0,examples=0;
    for(const file of fs.readdirSync(path.join(__dirname,'../docs')).filter(file=>file.endsWith('openapi.json'))) {
        const document=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs',file),'utf8'));
        function schema(value) {
            checkVocabulary(value,document);schemas++;
            if(Object.hasOwn(value,'example')){validateExample(value.example,value,document);examples++;}
        }
        function walk(value) {
            if(!value||typeof value!=='object')return;
            for(const[key,child]of Object.entries(value)) {
                if(key==='schemas')Object.values(child).forEach(schema);
                else if(key==='schema')schema(child);
                else walk(child);
            }
            if(value.schema&&Object.hasOwn(value,'example')){validateExample(value.example,value.schema,document);examples++;}
        }
        walk(document);
    }
    assert.ok(schemas>0); // Group OpenAPI examples join this check in T-5C-46.
});

test('T-5C-36: actor-class matrix covers G01-G17 and G26 with snapshots on every refusal',{timeout:240000},async t=>{
    const f=await httpGroupFixture(t,{clock:createClock(),features:{groupApi:true,groups:{directAdd:true,maxMembers:50,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    const actors=['unauthenticated','nonMember','pendingInvitee','member','admin','owner','removedMember'];
    const ids=['G01','G02','G03','G04','G05','G06','G07','G08','G09','G10','G11','G12','G13','G14','G15','G16','G17','G26'];
    const groupFor=(route,actorClass,suffix='')=>{
        const id=`matrix-${route.toLowerCase()}-${actorClass.toLowerCase()}${suffix}`;
        f.builder.createGroup({ownerId:f.actors.owner.id,conversationId:id,title:id,idempotencyKey:null});
        f.builder.addMember(id,f.actors.admin.id,{role:'admin'});f.builder.addMember(id,f.actors.member.id);
        f.builder.addMember(id,f.actors.removedMember.id);f.builder.removeMember(id,f.actors.removedMember.id);
        const invitationId=f.builder.invite(id,f.actors.owner.id,f.actors.pendingInvitee.id);
        return{id,invitationId};
    };
    const urlFor=(route,id,invitationId)=>'/api/groups'+route.path.replace(':id',id).replace(':userId',f.actors.member.id).replace(':invitationId',invitationId);
    const validBody=(route,id)=>({G01:{name:`matrix-${id}`},G04:{name:`updated-${id}`},G06:{userId:f.actors.nonMember.id},
        G08:{role:'admin'},G10:{userId:f.actors.member.id},G12:{userId:f.actors.nonMember.id}})[route.id];
    const invalidBody=(route,id)=>({G01:{name:''},G04:{name:'',unknown:true},G06:{userId:f.actors.nonMember.id,role:'owner'},
        G08:{role:'owner'},G10:{userId:f.actors.member.id,membershipRevision:'stale'},G12:{userId:''}})[route.id]??{unexpected:'invalid-for-contract'};
    const expected=(route,actorClass)=>{
        if(actorClass==='unauthenticated')return[401,'UNAUTHENTICATED'];
        if(['G01','G02','G26','G15'].includes(route.id))return[route.success[0],null];
        if(['G16','G17'].includes(route.id))return actorClass==='pendingInvitee'?[route.success[0],null]:[404,'NOT_FOUND'];
        if(['nonMember','pendingInvitee','removedMember'].includes(actorClass))return[404,'NOT_FOUND'];
        const role={owner:'owner',admin:'admin',member:'member'}[actorClass];
        if(route.id==='G09'&&role==='owner')return[409,'CONFLICT'];
        const minimum={G04:'owner',G06:'admin',G07:'admin',G08:'owner',G10:'owner',G11:'owner',G12:'admin',G13:'admin',G14:'admin'}[route.id];
        if(minimum&&({member:0,admin:1,owner:2}[role]<({member:0,admin:1,owner:2}[minimum])))return[403,'FORBIDDEN'];
        return[route.success[0],null];
    };
    let refusals=0,successes=0,csrfCells=0;
    for(const routeId of ids){
        const route=CONTRACT.find(item=>item.id===routeId);assert.ok(route,routeId);
        for(const actorClass of actors){
            const {id,invitationId}=groupFor(routeId,actorClass),url=urlFor(route,id,invitationId),actor=f.actors[actorClass];
            const [status,code]=expected(route,actorClass);
            const queryFault=['G02','G05','G13','G15'].includes(routeId)?'?limit=0':'';
            if(status>=400){
                for(const bad of [false,true]){
                    const before=snapshot(f.db),body=route.method==='GET'?undefined:bad?invalidBody(route,id):validBody(route,id);
                    const response=await actorRequest(actor,route.method,`${url}${queryFault}`,body===undefined?{}:{body});
                    assert.deepEqual([response.status,response.body],[status,{code,fields:[]}],`${routeId}/${actorClass}/${bad?'invalid':'valid'}`);
                    assertSecurityHeaders(response,`${routeId}/${actorClass}`);assert.deepEqual(snapshot(f.db),before,`${routeId}/${actorClass} refusal snapshot`);refusals++;
                }
            }else{
                const before=snapshot(f.db),body=validBody(route,id);
                const response=await actorRequest(actor,route.method,url,{method:route.method,...(body===undefined?{}:{body})});
                assert.equal(response.status,status,`${routeId}/${actorClass} success`);assertSecurityHeaders(response,`${routeId}/${actorClass}`);
                if(['G02','G03','G05','G13','G15','G26'].includes(routeId))assert.deepEqual(snapshot(f.db),before,`${routeId}/${actorClass} read is inert`);
                successes++;
            }
        }
        if(route.method!=='GET'){
            const {id,invitationId}=groupFor(routeId,'csrf'),url=urlFor(route,id,invitationId);
            for(const bad of [false,true]){
                const before=snapshot(f.db),body=bad?invalidBody(route,id):validBody(route,id);
                const response=await actorRequest(f.actors.owner,route.method,url,{csrf:false,...(body===undefined?{}:{body})});
                assert.deepEqual([response.status,response.body],[403,{code:'CSRF_INVALID',fields:[]}],`${routeId} CSRF ${bad?'invalid':'valid'} body`);
                assert.deepEqual(snapshot(f.db),before,`${routeId} CSRF refusal snapshot`);csrfCells++;
            }
        }
    }
    for(const actorClass of actors){
        const actor=f.actors[actorClass],{id}=groupFor('G04',actorClass,'-policy');
        const expectedPolicy=actorClass==='unauthenticated'?[401,'UNAUTHENTICATED']:
            ['nonMember','pendingInvitee','removedMember'].includes(actorClass)?[404,'NOT_FOUND']:
                actorClass==='owner'?[400,'VALIDATION_ERROR']:[403,'FORBIDDEN'];
        const before=snapshot(f.db),response=await actorRequest(actor,'PATCH',`/api/groups/${id}`,{body:{name:'policy attempt',historyPolicy:'all'}});
        assert.deepEqual([response.status,response.body],[expectedPolicy[0],{code:expectedPolicy[1],fields:expectedPolicy[0]===400?['historyPolicy']:[]}],`G04 historyPolicy/${actorClass}`);
        assert.deepEqual(snapshot(f.db),before,`G04 historyPolicy/${actorClass} changes no row`);
        if(actorClass==='owner'){
            f.db.prepare('UPDATE Conversations SET archived_at=? WHERE conversation_id=?').run(f.clock.iso(),id);
            const archivedBefore=snapshot(f.db),archived=await actorRequest(actor,'PATCH',`/api/groups/${id}`,{body:{name:'policy attempt',historyPolicy:'all'}});
            assert.deepEqual([archived.status,archived.body],[409,{code:'CONFLICT',fields:[]}],'archived owner meets 409 before policy validation');
            assert.deepEqual(snapshot(f.db),archivedBefore,'archived policy refusal changes no row');
        }
    }
    for(const actorClass of actors){
        const actor=f.actors[actorClass];
        if(actorClass==='unauthenticated'){
            const response=await actorRequest(actor,'POST','/api/groups',{body:{name:'valid',historyPolicy:'all'}});
            assert.deepEqual([response.status,response.body],[401,{code:'UNAUTHENTICATED',fields:[]}]);
            continue;
        }
        for(const policy of ['all','from_joined']){
            const before=snapshot(f.db),response=await actorRequest(actor,'POST','/api/groups',{body:{name:`G01 ${actorClass} ${policy}`,historyPolicy:policy}});
            assert.equal(response.status,201,`G01 valid policy/${actorClass}/${policy}`);
            assert.equal(f.db.prepare('SELECT history_policy FROM GroupExtensions WHERE conversation_id=?').get(response.body.group.id).history_policy,policy);
            assert.notEqual(snapshot(f.db).total,before.total);
        }
        const before=snapshot(f.db),invalid=await actorRequest(actor,'POST','/api/groups',{body:{name:`G01 invalid ${actorClass}`,historyPolicy:'ALL'}});
        assert.deepEqual([invalid.status,invalid.body],[400,{code:'VALIDATION_ERROR',fields:['historyPolicy']}]);
        assert.deepEqual(snapshot(f.db),before,'invalid G01 policy creates no row');
    }
    t.diagnostic(`T-5C-36 matrix routes=${ids.length} actors=${actors.length} refusals=${refusals} successes=${successes} csrf=${csrfCells}`);
    assert.equal(successes>0,true);assert.ok(refusals>=ids.length*actors.length);assert.ok(csrfCells>0);
});

test('P-21: generated route, actor and fault refusals preserve every protected table',{timeout:240000},async t=>{
    const f=await httpGroupFixture(t,{clock:createClock(),features:{groupApi:true,groups:{directAdd:true,maxMembers:50,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    const actorNames=['unauthenticated','nonMember','pendingInvitee','member','admin','owner','removedMember'];
    const listRoutes=new Set(['G02','G05','G13','G15']),staleRoutes=new Set(['G04','G08','G10']);
    const archiveRoutes=new Set(['G04','G06','G08','G10','G11','G12','G16']);
    const cases=[];
    for(const route of CONTRACT){
        if(route.id==='G26')continue;
        const faults=route.method==='GET'?(listRoutes.has(route.id)?['bad-query','bad-cursor']:['unknown-target']):['bad-body','wrong-content-type'];
        if(staleRoutes.has(route.id))faults.push('stale-state');
        if(archiveRoutes.has(route.id))faults.push('archived');
        for(const actorClass of actorNames)for(const fault of faults)cases.push({routeId:route.id,actorClass,fault});
    }
    let checked=0,dc09=0;
    await forAll('P-21',{runs:1,seed:0x5c210037,onRun:line=>t.diagnostic(line),describe:items=>items.map(item=>`${item.routeId}/${item.actorClass}/${item.fault}`)},
        random=>{const result=cases.slice();for(let i=result.length-1;i>0;i--){const j=random.int(0,i);[result[i],result[j]]=[result[j],result[i]];}return result;},
        async(items,info)=>{
            for(let index=0;index<items.length;index++){
                const item=items[index],route=CONTRACT.find(row=>row.id===item.routeId),actor=f.actors[item.actorClass];
                const groupId=`p21-${String(index).padStart(4,'0')}`;
                f.builder.createGroup({ownerId:f.actors.owner.id,conversationId:groupId,title:groupId,idempotencyKey:null});
                f.builder.addMember(groupId,f.actors.admin.id,{role:'admin'});f.builder.addMember(groupId,f.actors.member.id);
                f.builder.addMember(groupId,f.actors.removedMember.id);f.builder.removeMember(groupId,f.actors.removedMember.id);
                const invitationId=f.builder.invite(groupId,f.actors.owner.id,f.actors.pendingInvitee.id);
                let url='/api/groups'+route.path.replace(':id',groupId).replace(':userId',f.actors.member.id).replace(':invitationId',invitationId);
                let options={},archivedAccept=false;
                if(item.fault==='bad-body'){
                    options={rawBody:'{',headers:{'Content-Type':'application/json'}};
                }else if(item.fault==='wrong-content-type'){
                    options={rawBody:'{}',headers:{'Content-Type':'text/plain'}};
                }else if(item.fault==='bad-query'){
                    url+='?unexpected=1';
                }else if(item.fault==='bad-cursor'){
                    url+='?limit=10&cursor=%21';
                }else if(item.fault==='unknown-target'){
                    url=url.replace(groupId,'p21-unknown-target');
                }else if(item.fault==='stale-state'){
                    const body={G04:{name:'stale',membershipRevision:999},G08:{role:'admin',membershipRevision:999},G10:{userId:f.actors.member.id,membershipRevision:999}}[route.id];
                    options={body};
                }else if(item.fault==='archived'){
                    f.db.prepare('UPDATE Conversations SET archived_at=? WHERE conversation_id=?').run(f.clock.iso(),groupId);
                    if(route.id==='G16'&&item.actorClass==='pendingInvitee')archivedAccept=true;
                    if(route.id==='G16'&&item.actorClass!=='pendingInvitee')options={};
                }
                const before=snapshot(f.db),response=await actorRequest(actor,route.method,url,options);
                assert.ok(response.status>=400,`P-21 ${item.routeId}/${item.actorClass}/${item.fault} unexpectedly succeeded`);
                assertSecurityHeaders(response,`P-21 ${item.routeId}/${item.actorClass}/${item.fault}`);
                if(archivedAccept){
                    assert.deepEqual([response.status,response.body],[409,{code:'CONFLICT',fields:[]}]);
                    assert.deepEqual(changedTables(before,snapshot(f.db)).sort(),['AuditLogs','ConversationInvitations']);
                    assert.equal(f.db.prepare('SELECT state FROM ConversationInvitations WHERE invitation_id=?').get(invitationId).state,'cancelled');dc09++;
                }else assert.deepEqual(snapshot(f.db),before,`P-21 ${item.routeId}/${item.actorClass}/${item.fault} snapshot`);
                checked++;
                assert.ok(info.seed>=0);
            }
        });
    t.diagnostic(`P-21 checked=${checked} routeActorFaultCases dc09=${dc09}`);
    assert.equal(checked,cases.length);assert.equal(dc09,1);
});

test('P-22: denial errors are contract-shaped, canaries stay out of errors, and uniform 404 causes are indistinguishable',{timeout:240000},async t=>{
    const f=await httpGroupFixture(t,{clock:createClock(),features:{groupApi:true,groups:{directAdd:true,maxMembers:50,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    const safeHeaders=response=>Object.fromEntries([...response.headers.entries()].filter(([name])=>name.toLowerCase()!=='date').sort(([a],[b])=>a.localeCompare(b)));
    const removed=f.actors.removedMember,unknownGroup='p22-unknown-group-4f6a',canary='P22-CANARY-../"\\path\n<stack>\u00e9';
    const invitationId=f.invitationId,unknownInvitation='p22-unknown-invitation-4f6a';
    const direct=f.repositories.conversations.create({conversation_id:'p22-direct-id',kind:'direct',dm_user_low:[f.actors.owner.id,f.actors.member.id].sort()[0],
        dm_user_high:[f.actors.owner.id,f.actors.member.id].sort()[1],origin:'authenticated',created_by:f.actors.owner.id}).conversation_id;
    const legacy=f.repositories.conversations.create({conversation_id:'p22-legacy-group',kind:'group',title:'legacy',created_by:f.actors.owner.id,origin:'legacy'}).conversation_id;
    const bare=f.repositories.conversations.create({conversation_id:'p22-bare-group',kind:'group',title:'bare',created_by:f.actors.owner.id,origin:'authenticated'}).conversation_id;
    const otherInvite=f.builder.invite(f.groupId,f.actors.owner.id,f.actors.nonMember.id);
    let removedRoutes=0,uniformPairs=0;
    for(const route of CONTRACT){
        const id=route.method==='POST'&&route.id==='G01'?'':f.groupId;
        const urlFor=(groupId,invite=invitationId)=>'/api/groups'+route.path.replace(':id',groupId).replace(':userId',f.actors.member.id).replace(':invitationId',invite);
        if(route.id==='G01'||route.id==='G02'||route.id==='G15'||route.id==='G26'){
            // These routes have no group visibility predicate; still verify malformed client text cannot escape in errors.
            if(route.id==='G01'){
                const before=snapshot(f.db),response=await actorRequest(removed,'POST','/api/groups',{body:{name:canary,unknown:canary}});
                assert.equal(response.status,400);assert.deepEqual(Object.keys(response.body).sort(),['code','fields']);
                assert.ok(response.body.fields.every(field=>/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field)));
                assert.ok(!response.text.includes(canary));assert.deepEqual(snapshot(f.db),before);
            }else{
                const response=await actorRequest(removed,'GET',route.id==='G26'?'/api/groups/feature-status':urlFor(f.groupId));
                assert.equal(response.status,route.success[0],`${route.id}: removed-member route was exercised`);
            }
            continue;
        }
        const routeUrl=urlFor(id);
        const options=route.method==='GET'?{}:{body:{name:canary,role:'owner',userId:'P22-CANARY-target'}};
        const response=await actorRequest(removed,route.method,routeUrl,options);
        assert.equal(response.status,404,`${route.id}: removed member attempted`);removedRoutes++;
        assert.deepEqual(response.body,{code:'NOT_FOUND',fields:[]},`${route.id}: exact 404 body`);
        assertSecurityHeaders(response,route.id);
        const uniformCauses=['G16','G17'].includes(route.id)?[]:[
            ['unknown',f.actors.owner,urlFor(unknownGroup)],
            ['malformed',f.actors.owner,urlFor('not-a-valid-group-id-!')],
            ['direct',f.actors.owner,urlFor(direct)],['legacy',f.actors.owner,urlFor(legacy)],['bare',f.actors.owner,urlFor(bare)],
            ['non-member',f.actors.nonMember,urlFor(f.groupId)],['pending invitee',f.actors.pendingInvitee,urlFor(f.groupId)],
        ];
        for(const [cause,actor,targetUrl] of uniformCauses){
            const denied=await actorRequest(actor,route.method,targetUrl,options);
            assert.deepEqual([denied.status,denied.body,safeHeaders(denied)],[response.status,response.body,safeHeaders(response)],`${route.id}: ${cause} uniform 404`);uniformPairs++;
        }
        if(route.id==='G16'||route.id==='G17'){
            const other=await actorRequest(f.actors.pendingInvitee,route.method,urlFor('',otherInvite),options);
            const missing=await actorRequest(f.actors.pendingInvitee,route.method,urlFor('',unknownInvitation),options);
            assert.deepEqual([other.status,other.body,safeHeaders(other)],[missing.status,missing.body,safeHeaders(missing)],`${route.id}: invitation addressed to another user versus unknown`);
            assert.equal(other.status,404);uniformPairs++;
        }
        assert.ok(!response.text.includes(canary),`${route.id}: no canary in error`);
    }
    assert.equal(removedRoutes,14);assert.ok(uniformPairs>=86);
    const before=snapshot(f.db),stderr=[],originalWrite=process.stderr.write;let malformed,pathCanary;
    process.stderr.write=function(chunk,...args){stderr.push(String(chunk));return originalWrite.call(this,chunk,...args);};
    try{
        malformed=await actorRequest(f.actors.owner,'PATCH',`/api/groups/${f.groupId}`,{body:{name:canary,description:canary,unknown:canary}});
        pathCanary=await actorRequest(removed,'GET',`/api/groups/${encodeURIComponent(canary)}`);
    }finally{process.stderr.write=originalWrite;}
    assert.equal(malformed.status,400);assert.deepEqual(Object.keys(malformed.body).sort(),['code','fields']);
    assert.ok(malformed.body.fields.length>0&&malformed.body.fields.every(field=>/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field)));
    assert.ok(!malformed.text.includes(canary)&&!pathCanary.text.includes(canary));assert.equal(pathCanary.status,404);
    assert.ok(!/stack|sqlite|constraint|trigger|[A-Za-z]:\\|\/var\/lib/i.test(`${malformed.text}\n${pathCanary.text}`));
    assert.deepEqual(snapshot(f.db),before);
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM AuditLogs').all()).includes('P22-CANARY'));
    assert.ok(!stderr.join('').includes('P22-CANARY'));
    t.diagnostic(`P-22 removedRoutes=${removedRoutes} uniform404Comparisons=${uniformPairs} canaryErrors=2`);
});

test('T-5C-39: forwarded headers cannot alter shared source buckets while user buckets remain distinct',{timeout:120000},async t=>{
    const calls=[];let denyReads=false;const limiter={consume(buckets){calls.push(buckets.map(bucket=>({...bucket})));return denyReads&&buckets.some(bucket=>bucket.key.startsWith('groups:read:'))?
        {allowed:false,retryAfterSeconds:3}:{allowed:true};}};
    const f=await httpGroupFixture(t,{clock:createClock(),limiter,users:['p22-rate-alice','p22-rate-bob'],features:{groupApi:true,
        groups:{directAdd:true,maxMembers:50,maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    calls.length=0;
    for(const [actor,forwarded] of [[f.actors.owner,{'X-Forwarded-For':'6.6.6.6',Forwarded:'for=7.7.7.7','X-Real-IP':'8.8.8.8'}],
        [f.actors.member,{'X-Forwarded-For':'9.9.9.9',Forwarded:'for=10.10.10.10','X-Real-IP':'11.11.11.11'}]]){
        const response=await actorRequest(actor,'GET',`/api/groups/${f.groupId}`,{headers:forwarded});assert.equal(response.status,200);
    }
    const pairs=calls.map(call=>call.map(bucket=>bucket.key));
    assert.equal(pairs.length,2);assert.equal(pairs[0][1],'groups:read-source:127.0.0.1');assert.equal(pairs[1][1],pairs[0][1]);
    assert.notEqual(pairs[0][0],pairs[1][0]);assert.ok(pairs.flat().every(key=>!/(6\.6\.6\.6|7\.7\.7\.7|8\.8\.8\.8|9\.9\.9\.9|10\.10\.10\.10|11\.11\.11\.11)/.test(key)));
    denyReads=true;const before=snapshot(f.db),read=await actorRequest(f.actors.owner,'GET',`/api/groups/${f.groupId}`);
    assert.deepEqual([read.status,read.body,read.headers.get('retry-after')],[429,{code:'RATE_LIMITED',fields:[]},'3']);assert.deepEqual(snapshot(f.db),before);
    denyReads=false;const write=await actorRequest(f.actors.owner,'POST','/api/groups',{body:{name:'P39 independent write bucket'}});
    assert.equal(write.status,201,'exhausted read family does not prevent a mutation from using its own bucket family');
});
