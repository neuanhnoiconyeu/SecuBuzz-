export function makeAttachmentFile(name: string, type: string, size = 64): File {
  const extension = name.split('.').pop()?.toLowerCase();
  const hex = ['png', 'jpg', 'jpeg'].includes(extension ?? '') ? extension === 'png' ? '89504e470d0a1a0a' : 'ffd8ff'
    : ['doc', 'xls', 'ppt'].includes(extension ?? '') ? 'd0cf11e0a1b11ae1'
      : ['docx', 'xlsx', 'pptx', 'zip'].includes(extension ?? '') ? '504b0304'
        : extension === 'rar' ? '526172211a070100' : extension === '7z' ? '377abcaf271c' : '';
  const header = hex ? Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16))
    : new TextEncoder().encode(extension === 'pdf' ? '%PDF-1.7\n' : extension === 'mp4' ? '0000ftypisom' : extension === 'mp3' ? 'ID3'
      : extension === 'rtf' ? '{\\rtf1 test}' : extension === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' : 'example text');
  const bytes = new Uint8Array(Math.max(size, header.length));
  if (extension === 'txt' || extension === 'csv' || extension === 'svg') bytes.fill(32);
  bytes.set(header);
  return new File([bytes], name, { type });
}
