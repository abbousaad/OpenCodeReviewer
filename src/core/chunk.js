/**
 * Cut `text` to at most `maxBytes` of UTF-8 without splitting a character.
 */
export function clipBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Back off continuation bytes so the cut lands on a character boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Split `text` into chunks of whole lines, each at most `maxBytes` of UTF-8.
 * A single line longer than `maxBytes` is clipped and its chunk is marked
 * truncated. Returns [{ text, startLine, endLine, truncated }] (1-based lines).
 */
export function splitLines(text, maxBytes) {
  const lines = text.split(/(?<=\n)/);
  const chunks = [];
  let current = null;

  const flush = () => {
    if (current) chunks.push({ ...current, text: current.parts.join('') });
    current = null;
  };

  lines.forEach((line, i) => {
    let size = Buffer.byteLength(line, 'utf8');
    let truncated = false;
    if (size > maxBytes) {
      line = clipBytes(line, maxBytes);
      size = Buffer.byteLength(line, 'utf8');
      truncated = true;
    }
    if (current && current.bytes + size > maxBytes) flush();
    current ??= { parts: [], bytes: 0, startLine: i + 1, endLine: i + 1, truncated: false };
    current.parts.push(line);
    current.bytes += size;
    current.endLine = i + 1;
    current.truncated ||= truncated;
  });
  flush();

  return chunks.map(({ parts, bytes, ...chunk }) => chunk);
}
