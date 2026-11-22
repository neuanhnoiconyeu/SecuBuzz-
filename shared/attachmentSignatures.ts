/** Format detection only. This does not establish that a file is malware-free. */
export function matchesAttachmentSignature(name: string, bytes: Uint8Array): boolean {
  const extension = name.split('.').pop()?.toLowerCase();
  const hex = Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const ascii = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  switch (extension) {
    case 'pdf': return ascii.startsWith('%PDF-');
    case 'jpg': case 'jpeg': return hex.startsWith('ffd8ff');
    case 'png': return hex.startsWith('89504e470d0a1a0a');
    case 'gif': return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'webp': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'avif': return ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii.slice(8));
    case 'bmp': return ascii.startsWith('BM');
    case 'svg': return !/<!DOCTYPE|<!ENTITY/i.test(ascii) && /<svg(?:\s|>)/i.test(ascii);
    case 'rtf': return ascii.startsWith('{\\rtf');
    case 'doc': case 'xls': case 'ppt': return hex.startsWith('d0cf11e0a1b11ae1');
    case 'docx': case 'xlsx': case 'pptx': case 'zip': return /^504b(?:0304|0506|0708)/.test(hex);
    case 'rar': return hex.startsWith('526172211a0700') || hex.startsWith('526172211a070100');
    case '7z': return hex.startsWith('377abcaf271c');
    case 'mp4': case 'm4v': case 'm4a': return ascii.slice(4, 8) === 'ftyp';
    case 'mov': return ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(ascii.slice(4, 8));
    case 'webm': case 'weba': return hex.startsWith('1a45dfa3');
    case 'wav': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE';
    case 'ogg': return ascii.startsWith('OggS');
    case 'mp3': return ascii.startsWith('ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    case 'txt': case 'csv': return !bytes.includes(0);
    default: return false;
  }
}
