// Single boundary to the Kiro-owned public protocol API. Node 24 loads its TS ESM.
// No protocol source, crypto implementation, test directory or success fallback is copied.
let protocol=null;
try {
    const loaded=require('../../../server/src/e2ee/index.ts');
    const required=['validateDeviceRegistration','planDeviceRegistration','planDeviceRevocation','planEpochPublication',
        'verifyRecipientKeysSync','createRecipientKeyVerifier','parseMessageEnvelopeV2','envelopeV2Fingerprint'];
    if(required.every(name=>typeof loaded[name]==='function'))protocol=loaded;
} catch { /* Unavailable stays fail-closed. */ }
module.exports={protocol};
