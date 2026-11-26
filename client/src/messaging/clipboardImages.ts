const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

function normalizeClipboardImage(file: File, index: number, stamp: number): File {
  const mime = file.type.toLowerCase();
  const ext = IMAGE_MIME_EXTENSIONS[mime];
  const trimmed = file.name.trim();
  const hasExtension = /\.[a-z0-9]{2,5}$/i.test(trimmed);
  if (trimmed && hasExtension && !/^image\.[a-z0-9]+$/i.test(trimmed)) {
    return file;
  }
  const safeExt = ext ?? (trimmed.split('.').pop()?.toLowerCase() || 'png');
  const name = `pasted-image-${stamp}-${index + 1}.${safeExt}`;
  return new File([file], name, {
    type: file.type || `image/${safeExt}`,
    lastModified: file.lastModified || stamp,
  });
}

/**
 * Extracts deduplicated image Files from a paste event's ClipboardData.
 * Never accesses navigator.clipboard or persistent permissions.
 */
export function extractClipboardImages(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return [];
  const raw: File[] = [];
  if (clipboardData.items && clipboardData.items.length > 0) {
    for (const item of Array.from(clipboardData.items)) {
      if (item.kind === 'file' && item.type.toLowerCase().startsWith('image/')) {
        const file = item.getAsFile();
        if (file) raw.push(file);
      }
    }
  }
  if (raw.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    for (const file of Array.from(clipboardData.files)) {
      if (file.type.toLowerCase().startsWith('image/')) raw.push(file);
    }
  }
  if (raw.length === 0) return [];
  const seen = new Set<string>();
  const stamp = Date.now();
  const unique: File[] = [];
  for (const file of raw) {
    const key = `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalizeClipboardImage(file, unique.length, stamp));
  }
  return unique;
}
