'use strict';

// DB-6B A01-A06 HTTP boundary. Business rules stay in Attachment_Service;
// this router owns request ordering, protocol framing and response streaming.

const express = require('express');
const { pipeline } = require('node:stream');
const { AuthError, sendError } = require('../auth/errors');
const { parseHeader, FrameError, FRAME_CONTENT_TYPE } = require('../attachments/frame');
const { validateHeader, sizeDecision } = require('../attachments/validation');

const MAX_JSON_BYTES = 8192;
const READ_METHODS = Object.freeze(['GET', 'HEAD']);
const ROUTES = Object.freeze([
    Object.freeze({ id:'A01', method:'POST', path:'/' }),
    Object.freeze({ id:'A02', method:'POST', path:'/associations' }),
    Object.freeze({ id:'A04', method:'GET', path:'/:id/download' }),
    Object.freeze({ id:'A06', method:'GET', path:'/search' }),
    Object.freeze({ id:'A03', method:'GET', path:'/:id' }),
    Object.freeze({ id:'A05', method:'DELETE', path:'/:id' }),
]);
const FILE_ROUTES = Object.freeze([Object.freeze({ id:'A06', method:'GET', path:'/search' })]);
const sourceOf = request => request.socket.remoteAddress || 'unknown';
const isRead = request => READ_METHODS.includes(request.method);
const unavailable = () => new AuthError('FEATURE_UNAVAILABLE', 503, []);
const invalid = fields => new AuthError('VALIDATION_ERROR', 400, fields);
const tooLarge = () => new AuthError('PAYLOAD_TOO_LARGE', 413, []);
const ROUTE_ID = /^A0[1-6]$/;
for (const rows of [ROUTES, FILE_ROUTES]) {
    if (!Object.isFrozen(rows) || rows.some(row => !Object.isFrozen(row) || !ROUTE_ID.test(row.id))) {
        throw new TypeError('Attachment route table must be frozen and complete.');
    }
}

function declaresUnreadableCharset(request) {
    const parameters = String(request.headers['content-type'] || '').split(';').slice(1);
    return parameters.some(parameter => {
        const index = parameter.indexOf('=');
        if (index < 0 || parameter.slice(0, index).trim().toLowerCase() !== 'charset') return false;
        const value = parameter.slice(index + 1).trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
        return value !== 'utf-8';
    });
}
function asyncRoute(work) {
    return (request, response, next) => Promise.resolve().then(() => work(request, response)).catch(next);
}
function frameError(error) {
    if (!(error instanceof FrameError)) return error;
    if (error.code === 'HEADER_TOO_LARGE') return tooLarge();
    const fields = error.field ? [error.field] : [];
    return invalid(fields);
}
function jsonBodyStep(request, response, next) {
    if (isRead(request) || (request.method === 'POST' && request.path === '/')) return next();
    const length = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(length) && length > MAX_JSON_BYTES) return sendError(response, 'PAYLOAD_TOO_LARGE', 413);
    if (!request.headers['transfer-encoding'] && !length) return next();
    if (!request.is('application/json')) return sendError(response, 'VALIDATION_ERROR', 400);
    if (declaresUnreadableCharset(request)) return sendError(response, 'UNSUPPORTED_MEDIA_TYPE', 415);
    return express.json({ limit:MAX_JSON_BYTES, strict:true, inflate:false })(request, response, next);
}
function createAttachmentRouters(attachments, middleware) {
    if (!middleware || typeof middleware.requireAuth !== 'function' || typeof middleware.requireCsrf !== 'function') {
        throw new TypeError('createAttachmentRouters needs authentication middleware.');
    }
    const router = express.Router({ caseSensitive:true });
    const files = express.Router({ caseSensitive:true });
    const requireCsrf = (request, response, next) => READ_METHODS.includes(request.method)
        ? next() : middleware.requireCsrf(request, response, next);
    const gate = (request, response, next) => attachments?.features?.attachmentApi === true
        ? next() : next(unavailable());
    const limit = (request, response, next) => {
        if (!attachments || typeof attachments.rate !== 'function') return next(unavailable());
        try { attachments.rate(isRead(request) ? 'read' : 'write', request.auth, sourceOf(request)); next(); }
        catch (error) { next(error); }
    };
    const chain = target => {
        target.use(middleware.requireAuth);
        target.use(requireCsrf);
        target.use(gate);
        target.use(limit);
        target.use(jsonBodyStep);
    };

    chain(router);
    chain(files);

    const upload = asyncRoute(async (request, response) => {
        const mediaType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== FRAME_CONTENT_TYPE) throw invalid([]);
        let headerLength = null;
        let header;
        try { header = await parseHeader(request, { onHeaderLength:length => { headerLength = length; } }); }
        catch (error) { throw frameError(error); }
        const checked = validateHeader(header);
        if (!checked.ok) {
            if (checked.status === 413) throw tooLarge();
            throw invalid(checked.fields);
        }
        const size = sizeDecision(header.byteSize, null);
        if (size.status === 413) throw tooLarge();
        if (Buffer.byteLength(header.encryptedMetadata, 'utf8') > 16384) throw invalid(['encryptedMetadata']);
        const rawLength = request.headers['content-length'];
        if (rawLength !== undefined) {
            if (!/^(0|[1-9][0-9]*)$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) throw invalid([]);
            if (headerLength === null || Number(rawLength) !== headerLength + header.byteSize) throw invalid([]);
        }
        const attachment = await attachments.upload(request.auth, request.csrfProof, header, request, sourceOf(request));
        response.status(201).json({ attachment });
    });

    const associate = (request, response) => {
        const rows = attachments.associate(request.auth, request.csrfProof, request.body);
        response.status(200).json({ attachments:rows });
    };
    const metadata = (request, response) => response.status(200).json({ attachment:attachments.metadata(request.auth, request.params.id) });
    const remove = asyncRoute(async (request, response) => {
        await attachments.remove(request.auth, request.csrfProof, request.params.id);
        response.status(204).end();
    });
    const download = asyncRoute(async (request, response) => {
        const result = await attachments.download(request.auth, request.params.id);
        response.status(200).set(result.headers);
        pipeline(result.stream, response, error => {
            if (error) {
                if (!response.destroyed) response.destroy(error);
                return;
            }
            if (response.writableFinished) result.onSent();
        });
    });
    const search = (request, response) => response.status(200).json(attachments.search(request.auth, request.query));

    // Fixed routes precede parameter routes; no filesystem/static route exists.
    router.post('/associations', associate);
    router.post('/', upload);
    router.get('/:id/download', download);
    router.get('/:id', metadata);
    router.delete('/:id', remove);
    router.use((request, response) => sendError(response, 'NOT_FOUND', 404));

    files.get('/search', search);
    files.use((request, response) => sendError(response, 'NOT_FOUND', 404));
    return Object.freeze({ attachments:router, files });
}

module.exports = { createAttachmentRouters, ATTACHMENT_ROUTES:ROUTES, FILE_ROUTES, MAX_JSON_BYTES };
