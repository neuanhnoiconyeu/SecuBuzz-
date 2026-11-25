'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const document = require('../docs/groups-openapi.json');
const { GROUP_ROUTES, createGroupRouter } = require('../server/routes/groups');
const { DISABLED_FEATURES } = require('../server/features/config');
const { CONTRACT, assertContractRoutes } = require('./support/contract');
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
function resolveSchema(schema) {
    if (!schema.$ref) return schema;
    return schema.$ref.slice(2).split('/').reduce((value, key) => value[key.replace(/~1/g, '/').replace(/~0/g, '~')], document);
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
