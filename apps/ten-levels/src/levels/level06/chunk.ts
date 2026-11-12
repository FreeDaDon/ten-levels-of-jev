/**
 * Level 6, shared: judge all of the text, not the first part of it.
 * Jev takes a bounded state, so long content goes in overlapping chunks, one call each, in parallel. The overlap
 * keeps a sentence that straddles a boundary whole in at least one chunk. A hard cap on chunks bounds the spend;
 * whatever lies beyond it is reported as unscreened instead of being silently skipped.
 */

export const CHUNK_CHARS = 6000;
export const CHUNK_OVERLAP = 300;
export const MAX_CHUNKS = 8;

export interface Chunked {
  chunks: string[];
  /** Characters beyond the last chunk that no call saw. */
  unscreened: number;
}

export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS): Chunked {
  if (text.length <= size) return { chunks: text ? [text] : [], unscreened: 0 };
  const chunks: string[] = [];
  const step = size - overlap;
  let covered = 0;
  for (let start = 0; start < text.length && chunks.length < maxChunks; start += step) {
    const end = Math.min(text.length, start + size);
    chunks.push(text.slice(start, end));
    covered = end;
    if (end === text.length) break;
  }
  return { chunks, unscreened: text.length - covered };
}
