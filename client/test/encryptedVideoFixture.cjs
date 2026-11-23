// A valid one-second VP8 WebM fixture, using the lossy VP8 keyframe from a browser-produced WebP.
// This avoids relying on hardware/MediaRecorder capture in headless Windows Chrome.
function webmFromWebP(webp){
  let frame;
  for(let offset=12;offset+8<=webp.length;){
    const size=webp.readUInt32LE(offset+4);
    if(webp.toString('ascii',offset,offset+4)==='VP8 ')frame=webp.subarray(offset+8,offset+8+size);
    offset+=8+size+(size%2);
  }
  if(!frame)throw new Error('Fixture requires a lossy VP8 WebP frame');
  const size=n=>{for(let bytes=1;bytes<=8;bytes++)if(n<2**(7*bytes)-1){const b=Buffer.alloc(bytes);let value=BigInt(n)|(1n<<BigInt(7*bytes));for(let i=bytes-1;i>=0;i--){b[i]=Number(value&255n);value>>=8n;}return b;}throw new Error('Fixture too large');};
  const tag=(id,...parts)=>{const payload=Buffer.concat(parts);return Buffer.concat([Buffer.from(id,'hex'),size(payload.length),payload]);};
  const integer=n=>{const bytes=[];do{bytes.unshift(n&255);n>>>=8;}while(n);return Buffer.from(bytes);};
  const text=s=>Buffer.from(s),duration=Buffer.alloc(8);duration.writeDoubleBE(1000);
  const header=tag('1a45dfa3',tag('4286',integer(1)),tag('42f7',integer(1)),tag('42f2',integer(4)),tag('42f3',integer(8)),tag('4282',text('webm')),tag('4287',integer(2)),tag('4285',integer(2)));
  const info=tag('1549a966',tag('2ad7b1',integer(1000000)),tag('4489',duration),tag('4d80',text('SecuBuzz fixture')),tag('5741',text('SecuBuzz fixture')));
  const tracks=tag('1654ae6b',tag('ae',tag('d7',integer(1)),tag('73c5',integer(1)),tag('83',integer(1)),tag('86',text('V_VP8')),tag('e0',tag('b0',integer(64)),tag('ba',integer(64)))));
  const blocks=[];for(let ms=0;ms<1000;ms+=100){const h=Buffer.from([0x81,0,0,0x80]);h.writeInt16BE(ms,1);blocks.push(tag('a3',h,frame));}
  return Buffer.concat([header,tag('18538067',info,tracks,tag('1f43b675',tag('e7',integer(0)),...blocks))]);
}
module.exports={webmFromWebP};
