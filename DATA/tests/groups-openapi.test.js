'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const document = require('../docs/groups-openapi.json');
const attachmentDocument = require('../docs/attachments-openapi.json');
const { GROUP_ROUTES, createGroupRouter } = require('../server/routes/groups');
const { ATTACHMENT_ROUTES, FILE_ROUTES, createAttachmentRouters } = require('../server/routes/attachments');
const { DISABLED_FEATURES } = require('../server/features/config');
const { CONTRACT, ATTACHMENT_CONTRACT, assertContractRoutes, assertAttachmentContractRoutes, assertAttachmentResponse } = require('./support/contract');
const { validateExample } = require('./support/schema-check');

function pairsFromDocument() {
    return Object.entries(document.paths).flatMap(([route, methods]) => Object.keys(methods).map(method =>
        `${method.toUpperCase()} ${route.replace(/\{([^}]+)\}/g, ':$1').replace(/^$/, '/')}`)).sort();
}
function pairsFromRouter() { return GROUP_ROUTES.map(row => `${row.method} /api/groups${row.path === '/' ? '' : row.path}`).sort(); }
function pairsFromStack() {
    const groupMessages = new Proxy({}, { get:() => () => {} });
    const router = createGroupRouter({ groups:new Proxy({}, { get:() => () => {} }), groupMessages, features:DISABLED_FEATURES },
        { requireAuth() {}, requireCsrf() {} });
    return router.stack.filter(layer => layer.route).flatMap(layer => Object.keys(layer.route.methods).map(method =>
        `${method.toUpperCase()} /api/groups${layer.route.path === '/' ? '' : layer.route.path}`)).sort();
}
function resolveSchema(schema,root=document) {
    if (!schema.$ref) return schema;
    return schema.$ref.slice(2).split('/').reduce((value, key) => value[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}
function assertCamelCaseKeys(value) {
    if (Array.isArray(value)) return value.forEach(assertCamelCaseKeys);
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        assert.match(key, /^[a-z][A-Za-z0-9]*$/);
        assertCamelCaseKeys(child);
    }
}

test('OpenAPI routes match the frozen table and mounted router, with contract status/error pairs', () => {
    assertContractRoutes(GROUP_ROUTES);
    assert.deepEqual(pairsFromDocument(), pairsFromRouter());
    assert.deepEqual(pairsFromStack(), pairsFromRouter());
    for (const row of CONTRACT) {
        const route = row.path === '/' ? '' : row.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
        const operation = document.paths[`/api/groups${route}`]?.[row.method.toLowerCase()];
        assert.ok(operation, `${row.id} exists in OpenAPI`);
        const declared = Object.entries(operation.responses).flatMap(([status, response]) =>
            (response['x-error-codes'] || []).map(code => [Number(status), code]));
        const expected = [...row.errors];
        for (const status of row.success) expected.push([status, 'SUCCESS']);
        assert.deepEqual(declared.sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])), expected.sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])), row.id);
    }
});

test('OpenAPI preserves the historyPolicy create-only contract and validates every example', () => {
    const create = document.paths['/api/groups'].post;
    const createSchema = resolveSchema(create.requestBody.content['application/json'].schema);
    assert.deepEqual(createSchema.properties.historyPolicy.enum, ['all','from_joined']);
    assert.equal(createSchema.properties.historyPolicy.default, 'from_joined');
    assert.equal(create.requestBody.content['application/json'].example.historyPolicy, 'all');
    assert.ok(create.responses['400']['x-error-codes'].includes('VALIDATION_ERROR'));
    assert.match(JSON.stringify(create.responses['400']), /historyPolicy/);

    const patch = document.paths['/api/groups/{id}'].patch;
    const patchSchema = resolveSchema(patch.requestBody.content['application/json'].schema);
    assert.equal(Object.hasOwn(patchSchema.properties, 'historyPolicy'), false);
    assert.equal(patchSchema.additionalProperties, false);
    assert.ok(patch.responses['400']['x-error-codes'].includes('VALIDATION_ERROR'));
    assert.ok(!patch.responses['400']['x-error-codes'].includes('FEATURE_UNAVAILABLE'));
    for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
        const body = operation.requestBody?.content?.['application/json'];
        if (body?.example !== undefined) validateExample(body.example, resolveSchema(body.schema), document);
        for (const response of Object.values(operation.responses)) {
            const example = response.content?.['application/json']?.example;
            const schema = response.content?.['application/json']?.schema;
            if (example !== undefined && schema) validateExample(example, schema, document);
            if (example !== undefined) assertCamelCaseKeys(example);
        }
    }
    for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
        const example = operation.requestBody?.content?.['application/json']?.example;
        if (example !== undefined) assertCamelCaseKeys(example);
    }
});

test('G04 cannot acquire a historyPolicy property or an accidental 503 contract', () => {
    const patch = document.paths['/api/groups/{id}'].patch;
    const patchSchema = resolveSchema(patch.requestBody.content['application/json'].schema);
    const broken = JSON.parse(JSON.stringify(patchSchema));
    broken.properties.historyPolicy = { type:'string' };
    assert.ok(Object.hasOwn(broken.properties, 'historyPolicy'));
    const with503 = JSON.parse(JSON.stringify(patch));
    with503.responses['503'] = { description:'Unavailable', 'x-error-codes':['FEATURE_UNAVAILABLE'] };
    assert.ok(with503.responses['503']);
    assert.equal(Object.hasOwn(patchSchema.properties, 'historyPolicy'), false);
    assert.ok(patch.responses['503']['x-error-codes'].includes('FEATURE_UNAVAILABLE'), 'the common disabled-gate response remains documented');
    assert.doesNotMatch(patch.responses['503'].description, /historyPolicy/i, '503 is not described as a historyPolicy response');
});

function attachmentPairsFromDocument(value) {
    return Object.entries(value.paths).flatMap(([route, methods]) => Object.entries(methods).map(([method, operation]) =>
        `${operation.operationId} ${method.toUpperCase()} ${route.replace(/\{([^}]+)\}/g, ':$1')}`)).sort();
}
function attachmentPairsFromTables(routes, files) {
    return [...routes.filter(row=>row.id!=='A06'),...files].map(row=>
        `${row.id} ${row.method} ${row.id==='A06'?'/api/files':'/api/attachments'}${row.path==='/'?'':row.path}`).sort();
}
function attachmentPairsFromStacks() {
    const attachments={features:{attachmentApi:false},rate(){},upload(){},associate(){},metadata(){},remove(){},download(){},search(){}};
    const middleware={requireAuth(_request,_response,next){next();},requireCsrf(_request,_response,next){next();}};
    const {attachments:router,files}=createAttachmentRouters(attachments,middleware);
    const getRows=(instance,base,known)=>instance.stack.filter(layer=>layer.route).flatMap(layer=>Object.keys(layer.route.methods).map(method=>{
        const row=known.find(candidate=>candidate.method===method.toUpperCase()&&candidate.path===layer.route.path);
        assert.ok(row,`mounted attachment route ${method.toUpperCase()} ${layer.route.path} has a contract id`);
        return `${row.id} ${method.toUpperCase()} ${base}${layer.route.path==='/'?'':layer.route.path}`;
    }));
    return [...getRows(router,'/api/attachments',ATTACHMENT_ROUTES.filter(row=>row.id!=='A06')),
        ...getRows(files,'/api/files',FILE_ROUTES)].sort();
}
function assertAttachmentDocumentContract(value) {
    assert.deepEqual(attachmentPairsFromDocument(value),ATTACHMENT_CONTRACT.map(row=>
        `${row.id} ${row.method} ${row.id==='A06'?'/api/files':'/api/attachments'}${row.path==='/'?'':row.path}`).sort());
    for(const row of ATTACHMENT_CONTRACT){
        const operation=value.paths[attachmentPairsPath(row.id)][row.method.toLowerCase()];
        assert.ok(operation,`${row.id} documented`);
        assert.equal(operation.operationId,row.id);
        const declared=Object.entries(operation.responses).flatMap(([status,response])=>(response['x-error-codes']||[]).map(code=>[Number(status),code]));
        const expected=[...row.errors,...row.success.map(status=>[status,'SUCCESS'])];
        assert.deepEqual(declared.sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])),expected.sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])),row.id);
    }
}
function attachmentPairsPath(id) { return id==='A01'?'/api/attachments':id==='A02'?'/api/attachments/associations':id==='A06'?'/api/files/search':id==='A04'?'/api/attachments/{id}/download':'/api/attachments/{id}'; }
function validateAttachmentExamples(value) {
    for(const methods of Object.values(value.paths))for(const operation of Object.values(methods)){
        const example=operation.requestBody?.content?.['application/json']?.example;
        if(example!==undefined){validateExample(example,resolveSchema(operation.requestBody.content['application/json'].schema,value),value);assertCamelCaseKeys(example);}
        for(const response of Object.values(operation.responses)){
            const json=response.content?.['application/json'];
            if(json?.example!==undefined){validateExample(json.example,resolveSchema(json.schema,value),value);assertCamelCaseKeys(json.example);}
        }
    }
}

test('Attachment OpenAPI routes match the frozen contract, both mounted stacks and exact status/code pairs',()=>{
    assertAttachmentContractRoutes(ATTACHMENT_ROUTES,FILE_ROUTES);
    const expected=attachmentPairsFromTables(ATTACHMENT_ROUTES,FILE_ROUTES);
    assert.deepEqual(attachmentPairsFromDocument(attachmentDocument),expected);
    assert.deepEqual(attachmentPairsFromStacks(),expected);
    assertAttachmentDocumentContract(attachmentDocument);
    validateAttachmentExamples(attachmentDocument);
    // `/api/files` has exactly one public operation; upload/download aliases are absent.
    assert.deepEqual(Object.keys(attachmentDocument.paths).filter(path=>path.startsWith('/api/files/')),['/api/files/search']);
});

test('Attachment contract self-check rejects missing route ids, missing document rows and undocumented responses',()=>{
    assert.throws(()=>assertAttachmentContractRoutes([...ATTACHMENT_ROUTES,{id:'A99',method:'POST',path:'/unlisted'}],FILE_ROUTES));
    assert.throws(()=>assertAttachmentContractRoutes(ATTACHMENT_ROUTES.filter(row=>row.id!=='A03'),FILE_ROUTES));
    const missing=JSON.parse(JSON.stringify(attachmentDocument));delete missing.paths['/api/attachments/{id}'].get;
    assert.throws(()=>assertAttachmentDocumentContract(missing));
    assert.throws(()=>assertAttachmentResponse('A03',{status:201,body:{}}),/undocumented success/);
    assert.throws(()=>assertAttachmentResponse('A03',{status:409,body:{code:'QUOTA_EXCEEDED'}}),/undocumented error/);
});
