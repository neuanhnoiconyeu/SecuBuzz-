import { getAttachmentRule, sanitizeAttachmentName, validateAttachmentFile } from '../../../shared/attachmentPolicy';
import { matchesAttachmentSignature } from '../../../shared/attachmentSignatures';

export function readAttachmentBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('The file could not be read. Select it again.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Rebuild SVG from static drawing elements. No scripts, HTML, CSS, events, or external resources. */
export async function createSafeSvgPreview(blob: Blob): Promise<Blob> {
  const source = new TextDecoder().decode(await readAttachmentBytes(blob));
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG files containing document entities are not supported.');
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || document.querySelector('parsererror')) throw new Error('This SVG file could not be read.');
  const elements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'use', 'title', 'desc']);
  const attributes = new Set(['viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'transform', 'id', 'href', 'clip-path', 'mask', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'preserveAspectRatio']);
  const output = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null);
  let count = 0;
  function copy(input: Element, target: Element, depth = 0) {
    if (++count > 10000 || depth > 64) throw new Error('This SVG is too complex to preview safely.');
    for (const attribute of Array.from(input.attributes)) {
      if (!attributes.has(attribute.name)) continue;
      const value = attribute.value;
      if (attribute.name === 'href' && !/^#[\w.-]+$/.test(value)) continue;
      if (/url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) continue;
      if (/javascript:|data:|https?:|\/\/|\\/i.test(value)) continue;
      target.setAttribute(attribute.name, value);
    }
    for (const child of Array.from(input.childNodes)) {
      if (child.nodeType === 3) target.appendChild(output.createTextNode(child.textContent ?? ''));
      else if (child instanceof Element && elements.has(child.localName)) {
        const next = output.createElementNS('http://www.w3.org/2000/svg', child.localName);
        copy(child, next, depth + 1); target.appendChild(next);
      }
    }
  }
  copy(root, output.documentElement);
  return new Blob([new XMLSerializer().serializeToString(output)], { type: 'image/svg+xml' });
}

export async function prepareAttachmentFile(input: File): Promise<{ file: File; svgPreview?: Blob }> {
  const name = sanitizeAttachmentName(input.name);
  const error = validateAttachmentFile({ name, type: input.type, size: input.size });
  if (error) throw new Error(error);
  const rule = getAttachmentRule(name)!;
  const file = new File([input], name, { type: rule.mimeTypes[0], lastModified: input.lastModified });
  const bytes = new Uint8Array(await readAttachmentBytes(file.slice(0, 4096)));
  if (!matchesAttachmentSignature(name, bytes)) throw new Error(`${name} is corrupted or does not match its file type.`);
  return rule.mimeTypes[0] === 'image/svg+xml' ? { file, svgPreview: await createSafeSvgPreview(file) } : { file };
}
