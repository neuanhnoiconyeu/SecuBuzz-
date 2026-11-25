const {test}=require('node:test');const assert=require('node:assert/strict');const {Readable}=require('node:stream');const {encode,parseHeader,FrameError}=require('../server/attachments/frame');const {validateHeader,validateSearchQuery,sizeDecision,LIMITS,MESSAGE_LIMITS}=require('../server/attachments/validation');
const good={conversationId:'c1',byteSize:3,encryptedMetadata:'m',algorithm:'test',formatVersion:'1'};
test('approved frame vectors and round trips preserve content bytes',async()=>{for(const [h,b,hex] of [[{conversationId:'c1',byteSize:0,encryptedMetadata:'',algorithm:'test',formatVersion:'1'},Buffer.alloc(0),'000000627b22636f6e766572736174696f6e4964223a226331222c226279746553697a65223a302c22656e637279707465644d65746164617461223a22222c22616c676f726974686d223a2274657374222c22666f726d617456657273696f6e223a2231227d'],[{conversationId:'c1',byteSize:3,encryptedMetadata:'m',algorithm:'test',formatVersion:'1'},Buffer.from('abc'),'000000637b22636f6e766572736174696f6e4964223a226331222c226279746553697a65223a332c22656e637279707465644d65746164617461223a226d222c22616c676f726974686d223a2274657374222c22666f726d617456657273696f6e223a2231227d616263']])assert.equal(encode(h,b).toString('hex'),hex);for(const n of [0,1,3*1024*1024]){const b=Buffer.alloc(n,7),stream=Readable.from([encode({...good,byteSize:n},b)]);const parsed=await parseHeader(stream);assert.equal(parsed.byteSize,n);assert.deepEqual(Buffer.concat(await (async()=>{const a=[];for await(const c of stream)a.push(c);return a;})()),b);}});
test('frame parser rejects malformed headers without consuming content and reports safe fields',async()=>{for(const raw of [Buffer.from([0,0,0,0]),Buffer.from([0,0,0,2,0x7b,0]),Buffer.from([0,0,0,1,0x78])])await assert.rejects(parseHeader(Readable.from([raw])));const unknown=encode({...good,privateField:'x'});await assert.rejects(parseHeader(Readable.from([unknown])),e=>e.field==='privateField');const wrong=encode({...good,byteSize:'3'});await assert.rejects(parseHeader(Readable.from([wrong])),e=>e.field==='byteSize');const content=Buffer.from('payload'),stream=Readable.from([encode(good,content)]);await parseHeader(stream);const remain=[];for await(const c of stream)remain.push(c);assert.equal(Buffer.concat(remain).toString(),'payload');});
test('header validation and size boundaries are deterministic',()=>{assert.equal(validateHeader(good).ok,true);for(const key of ['conversationId','byteSize','encryptedMetadata','algorithm','formatVersion']){const bad={...good,[key]:null};assert.ok(validateHeader(bad).fields.includes(key));const missing={...good};delete missing[key];assert.ok(validateHeader(missing).fields.includes(key));}assert.deepEqual([0,1,52428799,52428800,52428801].map(n=>sizeDecision(n).status),[400,200,200,200,413]);assert.deepEqual(LIMITS,{image:5,document:10,audio:20,archive:25,video:50});assert.deepEqual(MESSAGE_LIMITS,{maxCount:5,maxTotalBytes:104857600});});

test('frame reader preserves split prefix/header bytes and payload coalesced with the header',async()=>{
    const full=encode(good,Buffer.from('payload'));
    for(const chunks of [[full],[full.subarray(0,1),full.subarray(1,3),full.subarray(3,4),full.subarray(4,9),full.subarray(9)],
        [full.subarray(0,4),full.subarray(4,full.length)]]){
        const stream=Readable.from(chunks);assert.deepEqual(await parseHeader(stream),good);const remaining=[];for await(const part of stream)remaining.push(part);assert.equal(Buffer.concat(remaining).toString(),'payload');
    }
});

test('frame reader bounds allocation and distinguishes truncated prefix, truncated header and stream errors',async()=>{
    const tooLarge=Buffer.alloc(4);tooLarge.writeUInt32BE(9);await assert.rejects(parseHeader(Readable.from([tooLarge]),{maxHeaderBytes:8}),e=>e.code==='HEADER_TOO_LARGE');
    await assert.rejects(parseHeader(Readable.from([Buffer.from([0,0])])),e=>e.code==='TRUNCATED_PREFIX');
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(4);await assert.rejects(parseHeader(Readable.from([prefix,Buffer.from('{}')])),e=>e.code==='TRUNCATED_HEADER');
    const failure=new Error('synthetic stream fault');const broken=new Readable({read(){this.destroy(failure);}});let emitted;broken.once('error',error=>{emitted=error;});const closed=new Promise(resolve=>broken.once('close',resolve));await assert.rejects(parseHeader(broken),e=>e===failure);await closed;assert.equal(emitted,failure);
});


test('frame parser rejects non-object JSON and does not expose unsafe field names',async()=>{
    for(const value of ['null','[]','"text"','1']){
        const json=Buffer.from(value);const prefix=Buffer.alloc(4);prefix.writeUInt32BE(json.length);
        await assert.rejects(parseHeader(Readable.from([Buffer.concat([prefix,json])]),{maxHeaderBytes:64}),e=>e.code==='INVALID_OBJECT');
    }
    const unsafe=encode({...good,'not-a-safe-field':'x'});
    await assert.rejects(parseHeader(Readable.from([unsafe])),e=>e.code==='UNKNOWN_FIELD'&&!('field' in e));
});

test('frame parser rejects streams closed before the bounded header is complete',async()=>{
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(20);
    const stream=new Readable({read(){this.push(Buffer.concat([prefix,Buffer.from('{}')]));this.destroy();}});
    await assert.rejects(parseHeader(stream),e=>e.code==='TRUNCATED_HEADER');
});

test('A06 search validation accepts only scoped metadata filters and canonical bounded page values',()=>{
    const valid=validateSearchQuery({conversationId:'direct-1',uploadedBy:'user-1',minBytes:'0',maxBytes:'50',
        createdAfter:'2026-01-01T00:00:00Z',createdBefore:'2026-01-02T00:00:00+00:00',limit:'50',cursor:'opaque'});
    assert.equal(valid.ok,true);assert.equal(valid.value.limit,50);assert.equal(valid.value.minBytes,0);
    assert.equal(valid.value.createdAfter,'2026-01-01T00:00:00.000Z');assert.equal(valid.value.createdBefore,'2026-01-02T00:00:00.000Z');
    assert.equal(validateSearchQuery({}).value.limit,20);
    for(const input of [{name:'private'},{content:'private'},{mediaType:'image'},{unknown:'x'},
        {minBytes:'2',maxBytes:'1'},{limit:'0'},{limit:'51'},{createdAfter:'bad'},{cursor:3}]){
        const result=validateSearchQuery(input);assert.equal(result.ok,false);assert.ok(result.fields.length>0);
    }
    const hostile={};Object.defineProperty(hostile,'bad\nfield',{value:'x',enumerable:true});
    assert.equal(validateSearchQuery(hostile).ok,false);
});
