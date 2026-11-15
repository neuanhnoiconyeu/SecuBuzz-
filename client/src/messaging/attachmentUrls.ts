/** Drafts and failed/sent messages can share a preview; revoke it after its final owner leaves. */
const references = new Map<string, number>();

export function createAttachmentUrl(file: Blob): string {
  const url = URL.createObjectURL(file);
  references.set(url, (references.get(url) ?? 0) + 1);
  return url;
}

export function retainAttachmentUrl(url: string): boolean {
  const count = references.get(url);
  if (count === undefined) return false;
  references.set(url, count + 1);
  return true;
}

export function releaseAttachmentUrl(url: string): void {
  const count = references.get(url);
  if (count === undefined) return;
  if (count > 1) references.set(url, count - 1);
  else { references.delete(url); URL.revokeObjectURL(url); }
}
