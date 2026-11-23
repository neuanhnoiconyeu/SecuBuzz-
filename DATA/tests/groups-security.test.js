'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GROUP_ROUTES}=require('../server/routes/groups');
const {CONTRACT,assertContractRoutes,assertContractResponse,assertGroupResponse,Browser}=require('./support/contract');
const {validateExample}=require('./support/schema-check');
const {httpGroupFixture,actorRequest}=require('./support/groups');

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
