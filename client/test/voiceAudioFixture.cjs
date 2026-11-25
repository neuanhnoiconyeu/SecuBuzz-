/** Deterministic mono PCM WAV for validation/integration tests; no physical microphone. */
function voiceWav(seconds=1,sampleRate=16000){
  const samples=Math.round(seconds*sampleRate),bytes=Buffer.alloc(44+samples*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(10000*Math.sin(2*Math.PI*440*i/sampleRate)),44+i*2);
  return bytes;
}
module.exports={voiceWav};
