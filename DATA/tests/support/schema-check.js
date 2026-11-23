'use strict';

// The schema vocabulary used by the existing DATA OpenAPI documents. Unknown
// keywords are errors even in an optional property that the example omits.
const assert = require('node:assert/strict');
const keywords = new Set(['$ref','type','properties','additionalProperties','required','items','enum','const',
    'minimum','maximum','minLength','maxLength','pattern','minItems','maxItems','minProperties','maxProperties',
    'format','description','default','title','example','examples','nullable','oneOf','anyOf','allOf','uniqueItems','writeOnly']);
function resolve(ref,root) {
    if(typeof ref!=='string'||!ref.startsWith('#/')) throw new Error('only local schema references are supported');
    return ref.slice(2).split('/').reduce((value,key)=>{
        const next=value?.[key.replace(/~1/g,'/').replace(/~0/g,'~')];
        if(next===undefined) throw new Error(`unresolved schema reference ${ref}`);
        return next;
    },root);
}
function checkVocabulary(schema,root,seen=new Set()) {
    if(typeof schema==='boolean')return;
    assert.ok(schema&&typeof schema==='object'&&!Array.isArray(schema),'schema must be an object');
    if(seen.has(schema))return; seen.add(schema);
    for(const key of Object.keys(schema))assert.ok(keywords.has(key),`unknown schema keyword ${key}`);
    if(schema.$ref)checkVocabulary(resolve(schema.$ref,root),root,seen);
    for(const child of Object.values(schema.properties||{}))checkVocabulary(child,root,seen);
    for(const key of ['items','additionalProperties'])if(schema[key]!==undefined)checkVocabulary(schema[key],root,seen);
    for(const key of ['oneOf','anyOf','allOf'])for(const child of schema[key]||[])checkVocabulary(child,root,seen);
}
function validateExample(value,schema,root=schema) {
    checkVocabulary(schema,root);
    function validate(v,s) {
        if(typeof s==='boolean') { assert.ok(s,'false schema');return; }
        if(s.$ref)validate(v,resolve(s.$ref,root));
        if(s.nullable&&v===null)return;
        const matches=(type)=>({null:v===null,array:Array.isArray(v),object:v!==null&&typeof v==='object'&&!Array.isArray(v),
            string:typeof v==='string',boolean:typeof v==='boolean',number:typeof v==='number'&&Number.isFinite(v),integer:Number.isSafeInteger(v)})[type];
        if(s.type)assert.ok([s.type].flat().some(matches),`expected type ${s.type}`);
        if(s.enum)assert.ok(s.enum.some(x=>{try{assert.deepEqual(v,x);return true;}catch{return false;}}),'enum');
        if(Object.hasOwn(s,'const'))assert.deepEqual(v,s.const,'const');
        if(typeof v==='number') { if(s.minimum!==undefined)assert.ok(v>=s.minimum,'minimum');if(s.maximum!==undefined)assert.ok(v<=s.maximum,'maximum'); }
        if(typeof v==='string') {
            if(s.minLength!==undefined)assert.ok([...v].length>=s.minLength,'minLength');
            if(s.maxLength!==undefined)assert.ok([...v].length<=s.maxLength,'maxLength');
            if(s.pattern)assert.match(v,new RegExp(s.pattern));
            if(s.format) {
                const formats={'date-time':()=>/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v)),
                    email:()=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),uri:()=>{try{new URL(v);return true;}catch{return false;}},
                    uuid:()=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)};
                assert.ok(formats[s.format],`unknown format ${s.format}`);assert.ok(formats[s.format](),`format ${s.format}`);
            }
        }
        if(Array.isArray(v)) {
            if(s.uniqueItems)for(let i=0;i<v.length;i++)for(let j=0;j<i;j++)assert.notDeepEqual(v[i],v[j],'uniqueItems');
            if(s.minItems!==undefined)assert.ok(v.length>=s.minItems,'minItems');if(s.maxItems!==undefined)assert.ok(v.length<=s.maxItems,'maxItems');
            if(s.items)v.forEach(x=>validate(x,s.items));
        } else if(v&&typeof v==='object') {
            if(s.minProperties!==undefined)assert.ok(Object.keys(v).length>=s.minProperties,'minProperties');
            if(s.maxProperties!==undefined)assert.ok(Object.keys(v).length<=s.maxProperties,'maxProperties');
            for(const key of s.required||[])assert.ok(Object.hasOwn(v,key),`required ${key}`);
            for(const[key,x]of Object.entries(v)) {
                if(Object.hasOwn(s.properties||{},key))validate(x,s.properties[key]);
                else if(s.additionalProperties!==undefined)validate(x,s.additionalProperties);
            }
        }
        for(const child of s.allOf||[])validate(v,child);
        for(const key of ['oneOf','anyOf'])if(s[key]) {
            const n=s[key].filter(child=>{try{validate(v,child);return true;}catch{return false;}}).length;
            assert.ok(key==='oneOf'?n===1:n>0,key);
        }
    }
    validate(value,schema);return true;
}
module.exports={ validateExample, checkVocabulary };
