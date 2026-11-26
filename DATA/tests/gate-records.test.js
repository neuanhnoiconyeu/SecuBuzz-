'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.resolve(__dirname, '..');
const ROOT = path.resolve(DATA, '..');
const gates = fs.readFileSync(path.join(DATA, 'docs/gate-records.md'), 'utf8');
const handoff = fs.readFileSync(path.join(DATA, 'docs/db5-db6-handoff.md'), 'utf8');
// Pinned from d7cd40a so the Validation_Runner can check dependency drift without requiring .git or an external fixture.
const baseline = Object.freeze({
    'DATA/package.json': {
        dependencies: { argon2:'0.45.2', 'better-sqlite3':'^13.0.3', dotenv:'^18.0.10', express:'^5.3.0' },
        devDependencies: { nodemon:'^3.1.14' }
    },
    'server/package.json': {
        dependencies: { 'better-sqlite3':'^13.0.3', express:'^5.3.0', 'livekit-server-sdk':'^2.19.3', 'socket.io':'^4.8.4' },
        devDependencies: { '@types/node':'^24.19.2', 'socket.io-client':'^4.8.4', tsx:'^4.23.15', typescript:'~5.9.3' }
    },
    'client/package.json': {
        dependencies: { '@hpke/core':'1.10.1', 'emoji-picker-react':'^5.1.4', 'livekit-client':'^2.24.1',
            'lucide-react':'^1.67.0', 'nes.css':'^2.2.1', next:'^14.0.0', react:'^18.2.0',
            'react-dom':'^18.2.0', 'socket.io-client':'^4.8.4', typescript:'^5.0.0' },
        devDependencies: { '@playwright/test':'1.65.1', '@testing-library/jest-dom':'^6.1.0',
            '@testing-library/react':'^14.0.0', '@types/jest':'^30.0.0', '@types/node':'^20.0.0',
            '@types/react':'^18.2.0', '@types/react-dom':'^18.2.0', autoprefixer:'^10.4.0', eslint:'^8.50.0',
            'eslint-config-next':'^14.0.0', 'fake-indexeddb':'6.2.8', jest:'^29.7.0',
            'jest-environment-jsdom':'^29.7.0', postcss:'^8.4.0', tailwindcss:'^3.3.0' }
    }
});

function dependencies(file) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return Object.fromEntries(['dependencies','devDependencies','optionalDependencies','peerDependencies']
        .filter(key => pkg[key]).map(key => [key, pkg[key]]));
}
function rootDockerFiles() {
    const found = [];
    const candidate = file => /^(?:compose(?:\..*)?\.ya?ml|docker-compose.*\.ya?ml|.*\.env\.example(?:\..*)?)$/i.test(path.basename(file));
    for (const name of fs.readdirSync(ROOT)) {
        const full = path.join(ROOT, name);
        if (fs.statSync(full).isFile() && candidate(full)) found.push(name);
    }
    const docker = path.join(ROOT, 'docker');
    if (fs.existsSync(docker)) for (const name of fs.readdirSync(docker)) {
        const full = path.join(docker, name);
        if (fs.statSync(full).isFile() && candidate(full)) found.push(path.join('docker', name));
    }
    return found;
}

test('T-5C-48: environment examples keep every Group API and messaging switch off', () => {
    const example = fs.readFileSync(path.join(DATA, '.env.example'), 'utf8');
    assert.match(example, /^GROUPS_API_ENABLED=false$/m);
    assert.match(example, /^GROUP_MESSAGING_ENABLED=false$/m);
    assert.match(example, /^GROUP_MAX_MEMBERS=50$/m);
    assert.match(example, /^GROUPS_API_GATE_RECORD=$/m);
    assert.match(example, /^GROUP_MESSAGING_GATE_RECORD=$/m);
    assert.match(example, /^# GROUP_MAX_PENDING_INVITATIONS_PER_GROUP=$/m);
    assert.match(example, /^# GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE=$/m);
    assert.doesNotMatch(example, /^GROUP_INVITATION_TTL_SECONDS=/m);
});

test('T-6B-49: attachment environment example stays off and requires explicit policy configuration',()=>{
    const example=fs.readFileSync(path.join(DATA,'.env.example'),'utf8');
    assert.match(example,/^ATTACHMENTS_API_ENABLED=false$/m);
    assert.match(example,/^ATTACHMENTS_API_GATE_RECORD=$/m);
    assert.match(example,/^# ATTACHMENT_STORAGE_DIR=$/m);
    for(const setting of ['ATTACHMENT_PENDING_TTL_SECONDS','ATTACHMENT_PURGE_DELAY_SECONDS','ATTACHMENT_RETENTION_INTERVAL_SECONDS',
        'ATTACHMENT_QUOTA_USER_BYTES','ATTACHMENT_QUOTA_CONVERSATION_BYTES','ATTACHMENT_MAX_PENDING_PER_USER','ATTACHMENT_UPLOADS_PER_HOUR',
        'ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER','ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE'])
        assert.match(example,new RegExp(`^# ${setting}=$`,'m'),`${setting} is named without a policy default`);
    assert.match(example,/^# ATTACHMENT_UPLOAD_TIMEOUT_SECONDS=$/m);
    for(const setting of ['ATTACHMENTS_API_ENABLED','ATTACHMENT_STORAGE_DIR','ATTACHMENT_PENDING_TTL_SECONDS','ATTACHMENT_PURGE_DELAY_SECONDS',
        'ATTACHMENT_RETENTION_INTERVAL_SECONDS','ATTACHMENT_QUOTA_USER_BYTES','ATTACHMENT_QUOTA_CONVERSATION_BYTES',
        'ATTACHMENT_MAX_PENDING_PER_USER','ATTACHMENT_UPLOADS_PER_HOUR','ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER',
        'ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE','ATTACHMENT_UPLOAD_TIMEOUT_SECONDS','ATTACHMENTS_API_GATE_RECORD'])
        assert.ok(example.includes(setting),`${setting} is documented`);
    assert.match(example,/compose\.yaml already sets[\s\S]*?ATTACHMENT_STORAGE_DIR=\/var\/lib\/secubuzz\/attachments/i);
    assert.ok(example.includes('sets no attachment')&&example.includes('switch or policy setting'));
    assert.match(example,/one shared bucket/i);
    assert.doesNotMatch(gates,/^## GR-ATTACHMENTS-PROTECTED-.*APPROVED/m);
    assert.doesNotMatch(gates,/^## GR-DB6-ACCEPTANCE-.*APPROVED/m);
});

test('T-5C-48: committed environment and Docker examples never enable a switch or premature client flag', () => {
    if (process.env.SECUBUZZ_DOCKER_VALIDATION === 'true') {
        assert.deepEqual(rootDockerFiles(), [], 'Validation_Runner image intentionally contains no root Docker files');
        return;
    }
    const files = rootDockerFiles();
    assert.ok(files.includes('compose.yaml'), 'host context includes the root Compose file');
    assert.ok(files.includes(path.join('docker','compose.env.example.yaml')), 'host context includes the Docker environment example');
    for (const relative of files) {
        const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
        for (const setting of ['GROUPS_API_ENABLED','GROUP_MESSAGING_ENABLED','ATTACHMENTS_API_ENABLED',
            'NEXT_PUBLIC_ATTACHMENT_API_READY','NEXT_PUBLIC_GROUPS_UI_READY']) {
            assert.doesNotMatch(source, new RegExp(`(?:^|\\s)${setting}\\s*[:=]\\s*['\"]?true(?:['\"]|\\s|$)`, 'im'), `${relative}: ${setting} stays off`);
        }
        for (const setting of ['GROUPS_API_GATE_RECORD','GROUP_MESSAGING_GATE_RECORD','ATTACHMENTS_API_GATE_RECORD'])
            assert.doesNotMatch(source, new RegExp(`(?:^|\\s)${setting}\\s*[:=]`, 'im'), `${relative}: no gate record is configured`);
        assert.doesNotMatch(source, /(?:^|\s)ATTACHMENTS_API_ENABLED\s*[:=]/im, `${relative}: no attachment switch assignment`);
        assert.doesNotMatch(source, /(?:^|\s)ATTACHMENT_(?!STORAGE_DIR\b)[A-Z0-9_]*\s*[:=]/im, `${relative}: no attachment policy setting`);
        assert.doesNotMatch(source, /(?:^|\s)NEXT_PUBLIC_ATTACHMENT_API_READY\s*[:=]\s*['"]?true(?:['"]|\s|$)/im,
            `${relative}: attachment client readiness stays false`);
    }
    for(const relative of ['compose.yaml',path.join('docker','compose.env.example.yaml')]) {
        const source=fs.readFileSync(path.join(ROOT,relative),'utf8');
        assert.match(source,/ATTACHMENT_STORAGE_DIR:\s*\/var\/lib\/secubuzz\/attachments/,`${relative}: reserved private storage root`);
    }
});

test('T-5C-48: Gate_Record identifiers, stages, approval boundary and inventory records are explicit', () => {
    const ids = [...gates.matchAll(/\b(GR-[A-Z0-9-]{3,48})\b/g)].map(match => match[1]);
    for (const id of ids) assert.match(id, /^GR-[A-Z0-9-]{3,48}$/);
    for (const stage of ['GROUP-MANAGEMENT','GROUP-MESSAGING','GROUP-REALTIME','GROUP-FRONTEND',
        'ATTACHMENTS-PROTECTED','DB5-ACCEPTANCE','DB6-ACCEPTANCE']) assert.ok(gates.includes(stage));
    assert.match(gates, /## GR-GROUP-MANAGEMENT-2026-11-23 .* APPROVED \(DB-5C stage gate; runtime disabled\)/);
    assert.match(gates, /Project_Owner approval: APPROVED — authority: Project Owner; date: 2026-11-23\./);
    assert.match(gates, /Operational activation: NOT AUTHORIZED\./);
    assert.match(gates, /Validation_Runner.*gate of record/i);
    assert.match(gates, /Windows host.*additional evidence/i);
    assert.match(gates, /Known_Baseline_Failure/i);
    const inventory = fs.readFileSync(path.join(DATA, 'docs/standalone-inventory.md'), 'utf8');
    const row = inventory.split(/\r?\n/).find(line => line.startsWith('| B-01 |'));
    assert.ok(row);
    assert.match(row, /groups-http\.test\.js/);
    assert.match(row, /groups-invitations\.test\.js/);
    assert.match(row, /ARCH-R03\.10/);
});

const APPROVED_ENCRYPTED_ATTACHMENT_REWRITES = Object.freeze([
    '/api/attachments/limits',
    '/api/attachments/batches/:cid/:mid',
    '/api/attachments/:id/download',
    '/api/attachments/:id',
    '/api/attachments',
]);

test('T-5C-48: package dependency sets match d7cd40a unless handoff records an exception', () => {
    for (const file of ['DATA/package.json','server/package.json','client/package.json']) {
        const current = dependencies(file);
        const allowed = handoff.includes(`Dependency exception: ${file}`);
        if (!allowed) assert.deepEqual(current, baseline[file], `${file} dependencies remain at d7cd40a`);
    }
    const nextConfigSource = fs.readFileSync(path.join(ROOT, 'client/next.config.js'), 'utf8');
    assert.doesNotMatch(nextConfigSource, /\/api\/(?:groups|attachments|files)/, 'client/next.config.js has no premature feature rewrite');

    const authProxyPath = path.join(ROOT, 'client/authProxy.cjs');
    const authProxySource = fs.readFileSync(authProxyPath, 'utf8');
    assert.doesNotMatch(authProxySource, /\/api\/(?:groups|files)/, 'client/authProxy.cjs has no premature groups or canonical files rewrite');
    assert.doesNotMatch(authProxySource, /\/api\/attachments\/(?:associations|search)\b/, 'client/authProxy.cjs has no premature DB-6B canonical attachment rewrite');
    const literalAttachmentPaths = authProxySource.match(/\/api\/attachments[^'"`\s]*/g) || [];
    for (const route of literalAttachmentPaths) {
        assert.ok(APPROVED_ENCRYPTED_ATTACHMENT_REWRITES.includes(route),
            `client/authProxy.cjs attachment literal ${route} must belong to pre-existing encrypted attachment routes`);
    }

    const proxy = require(authProxyPath);
    for (const fn of ['authProxyRewrites', 'socialProxyRewrites', 'messagingProxyRewrites', 'realtimeProxyRewrites']) {
        assert.deepEqual(proxy[fn]({ NODE_ENV: 'production' }), [], `${fn} stays fail-closed in production without AUTH_BACKEND_URL`);
    }
    const devEnv = { NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5000' };
    const devRoutes = [
        ...proxy.authProxyRewrites(devEnv),
        ...proxy.socialProxyRewrites(devEnv),
        ...proxy.messagingProxyRewrites(devEnv),
        ...proxy.realtimeProxyRewrites(devEnv),
    ];
    for (const route of devRoutes) {
        assert.doesNotMatch(route.source, /^\/api\/(?:groups|files)(?:\/|$)/, `unexpected gated route ${route.source}`);
        if (route.source.startsWith('/api/attachments')) {
            assert.ok(APPROVED_ENCRYPTED_ATTACHMENT_REWRITES.includes(route.source), `unapproved attachment rewrite ${route.source}`);
            assert.equal(route.destination, `http://127.0.0.1:5000${route.source}`);
        }
    }
    assert.deepEqual(devRoutes.map(r => r.source).filter(s => s.startsWith('/api/attachments')),
        APPROVED_ENCRYPTED_ATTACHMENT_REWRITES, 'encrypted attachment rewrites preserve exact static-first allowlist');
});

test('T-6A-22: attachment contract documents contain required sections and decision tables', () => {
    const storage = fs.readFileSync(path.join(DATA, 'docs/attachments-storage-contract.md'), 'utf8');
    const frame = fs.readFileSync(path.join(DATA, 'docs/attachments-upload-frame.md'), 'utf8');
    const api = fs.readFileSync(path.join(DATA, 'docs/attachments-api.md'), 'utf8');
    const protectedContent = fs.readFileSync(path.join(DATA, 'docs/attachments-protected-content.md'), 'utf8');

    for (const operation of ['write(key, readable, { maxBytes })','read(key)','stat(key)','exists(key)',
        'delete(key)','usage()','sweepTemporary(olderThanMs)','listKeys()']) assert.ok(storage.includes(operation), operation);
    for (const code of ['STORAGE_KEY','STORAGE_EXISTS','STORAGE_SIZE','STORAGE_MISSING','STORAGE_IO']) assert.ok(storage.includes(code), code);
    assert.match(storage, /## Contract tests/i);
    assert.match(storage, /## .*Docker_Environment/i);
    assert.match(storage, /sweepTemporary.*listKeys/s);

    assert.match(frame, /four-byte unsigned big-endian/i);
    assert.match(frame, /131,072 bytes/);
    assert.match(frame, /exactly `byteSize` opaque content bytes/);
    assert.match(frame, /52,428,800/);
    assert.match(frame, /00000062[0-9a-f]+/i);
    assert.match(frame, /00000063[0-9a-f]+/i);

    for (const id of ['A01','A02','A03','A04','A05','A06']) assert.match(api, new RegExp(`\\| ${id} \\|`), `${id} route row`);
    assert.match(api, /## Direct pair rule/i);
    assert.match(api, /uniform `404 NOT_FOUND`/i);
    for (let n=14;n<=21;n++) assert.match(api, new RegExp(`OD-${n}`), `OD-${n}`);
    for (const id of ['OA-01','OA-02','OA-03','OA-04']) assert.ok(api.includes(id), id);
    for (const id of ['OP-02','OP-03','OP-04','OP-05','OP-08','OP-10','OP-12','OP-13']) assert.ok(api.includes(id), id);
    assert.match(protectedContent, /declared_algorithm/);
    assert.match(protectedContent, /declared_format_version/);
    assert.match(protectedContent, /## Residual risk/i);
    assert.match(protectedContent, /DRAFT/);
});

test('T-6A-22: standalone artifact and port inventory covers every required server and client row', () => {
    const inventory = fs.readFileSync(path.join(DATA, 'docs/standalone-inventory.md'), 'utf8');
    const rows = inventory.split(/\r?\n/).filter(line => /^\| [ABCD]-\d{2} \|/.test(line));
    for (const prefix of ['A','B','C','D']) {
        const expected = prefix === 'A' ? 16 : prefix === 'B' ? 14 : prefix === 'C' ? 10 : 1;
        const group = rows.filter(line => line.startsWith(`| ${prefix}-`));
        assert.equal(group.length, expected, `${prefix} inventory row count`);
        for (const row of group) {
            assert.match(row, /\| (adapt|replace|retire|reuse as is) \|/i, row);
            const cols = row.split('|').map(value => value.trim());
            assert.ok(cols[6], `non-empty reason: ${row.slice(0,80)}`);
            assert.match(cols[7], /(?:ARCH|DB[56]|COMP|NFR|CI|AF|ADR)-R?\d/i, `requirement id: ${row.slice(0,80)}`);
        }
    }
    const serverRows = rows.filter(line => line.startsWith('| B-'));
    for (let n=1;n<=14;n++) assert.ok(serverRows.some(row => row.startsWith(`| B-${String(n).padStart(2,'0')} |`)), `server test ${n}`);
    const retiredAlias = serverRows.find(row => row.startsWith('| B-09 |'));
    assert.ok(retiredAlias);
    assert.match(retiredAlias, /\| retire \|/);

    const clientFiles = [
        ['YahooChatWindow.attachments.test.tsx',3], ['MessageAttachmentView.test.tsx',6],
        ['MessageComposer.attachments.test.tsx',22], ['useAttachmentSource.test.tsx',9],
        ['attachmentContent.test.ts',5], ['attachmentFiles.test.ts',3],
        ['attachmentUpload.test.ts',23], ['localAttachmentStore.test.ts',5]
    ];
    for (const [name,count] of clientFiles) {
        const row = rows.find(line => line.startsWith('| C-') && line.includes(name));
        assert.ok(row, `client test row ${name}`);
        assert.match(row, new RegExp(`: ${count} tests`), `client test count ${name}`);
    }
    assert.match(inventory, /76 client attachment tests/);
    assert.match(inventory, /stricter replacement/i);
});

test('T-6A-22: handoff records the T-6A-24 project, digest, size, memory, time and timeout result or fallback', () => {
    const section = handoff.split(/## DB-6A attachment contract and decision preparation/)[1];
    assert.ok(section, 'T-6A handoff section exists');
    const measurement = section.split('**Resumed T-6A-24 measurement')[1]?.split('#### DB-6A current-tree')[0];
    assert.ok(measurement, 'T-6A-24 measurement note exists');
    assert.match(measurement, /secubuzz-disposable-[0-9a-f]{8}\b/);
    const measured = /receiver byte count: [\d,]+/i.test(measurement) &&
        /SHA-256 digest: `[a-f0-9]{64}`/i.test(measurement) &&
        /HTTP \d{3} in [\d.]+ s/i.test(measurement) &&
        /timeout/i.test(measurement) && /docker stats samples: [\d.]+ MiB/i.test(measurement) &&
        /peak [\d,]+ bytes/i.test(measurement);
    const failedWithFallback = /failed measurement/i.test(measurement) && /fallback/i.test(measurement) &&
        ['byte count', 'SHA-256', 'peak memory', 'elapsed time', 'timeout behavior'].every(field =>
            measurement.toLowerCase().includes(field.toLowerCase()));
    assert.ok(measured || failedWithFallback, 'measurement has results or explicit failure and fallback');
});
