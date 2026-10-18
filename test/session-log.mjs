/**
 * Read DSH session logs.
 *
 * A session log is written as MANY zstd frames — one per flush, 57 of them in
 * the four-turn run this was written for — and every decompression API Node
 * exposes stops at the first frame boundary. `zstdDecompressSync()` and
 * `createZstdDecompress()` both return the 188-character session header and
 * nothing else: no error, no truncation signal, no hint that 167476 characters
 * went missing.
 *
 * That silence cost real debugging time. The end-to-end scripts searched the
 * transcript for tool names to prove "the model actually called this tool", and
 * read `false` for tools whose effects were plainly in the database — which
 * looks exactly like a broken tool chain rather than a broken reader. A reader
 * that returns the header therefore turns every log assertion into a lie, and it
 * lies in the direction that blames the code under test.
 *
 * So frames are located by their magic and decompressed one at a time. A magic
 * that appears inside a compressed block is not a frame boundary: that slice
 * throws and is skipped, which is the correct move — zstd's format is designed
 * to resync on the magic, and that is what makes the scan safe.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Every session directory in a DSH home, keyed by session id. */
export function sessionDirs(home) {
  const root = join(home, 'sessions');
  const found = new Map();
  if (!existsSync(root)) return found;
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket);
    for (const name of readdirSync(dir)) found.set(name, join(dir, name));
  }
  return found;
}

/** One session file, whole: every frame, joined. */
export function readSessionFile(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 4) return bytes.toString('utf8');
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) {
    return bytes.toString('utf8'); // already plain jsonl
  }

  const offsets = [];
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] === MAGIC[0] && bytes[i + 1] === MAGIC[1] && bytes[i + 2] === MAGIC[2] && bytes[i + 3] === MAGIC[3]) {
      offsets.push(i);
    }
  }

  const parts = [];
  for (const [index, start] of offsets.entries()) {
    const end = offsets[index + 1] ?? bytes.length;
    try {
      parts.push(zstdDecompressSync(bytes.subarray(start, end)).toString('utf8'));
    } catch {
      // Not a frame boundary: a magic that happened to appear inside a block.
    }
  }
  if (parts.length === 0) throw new Error(`${path}: ${offsets.length} frame magics but nothing decompressed`);
  return parts.join('');
}

/** Every session log in a home, concatenated. */
export function transcriptOf(home) {
  const parts = [];
  for (const dir of sessionDirs(home).values()) {
    for (const file of readdirSync(dir)) {
      try {
        parts.push(readSessionFile(join(dir, file)));
      } catch {
        // A file we cannot read is not evidence either way; the assertions are
        // about what we can see.
      }
    }
  }
  return parts.join('\n');
}

/** Event data of one type, in file order. */
export function eventsOf(log, type) {
  const found = [];
  for (const line of log.split('\n')) {
    if (!line.includes(`"${type}"`)) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === type) found.push(event);
  }
  return found;
}

/**
 * Every tool call in a transcript: `{turn, step, name, args, id}`.
 *
 * The call's fields sit directly on the event data, and the argument string is
 * JSON — hence the second parse, kept forgiving because a malformed argument is
 * the model's business, not the reader's.
 */
export function toolCallsOf(log) {
  return eventsOf(log, 'tool/call').map((event) => {
    const data = event.data ?? {};
    const raw = data.arguments ?? data.message?.arguments;
    let args = {};
    try {
      args = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
    } catch {
      args = {};
    }
    return { turn: data.turn, step: data.step, name: data.name ?? data.message?.name, args, raw: String(raw ?? '') };
  });
}

/**
 * The short ids the tools actually printed, as a set.
 *
 * Renders print ids as `[xxxxxxxx]`, and that bracket is the whole contract: an
 * id only exists for the model if a tool put it in a result. Collected from
 * tool results only — not from the whole transcript, which also contains the
 * model's own text and could contain an id it invented.
 */
export function printedIdsOf(log) {
  const printed = new Set();
  for (const event of eventsOf(log, 'tool/result')) {
    const text = (event.data?.message?.content ?? []).map((block) => block.text ?? '').join('');
    for (const match of text.matchAll(/\[([0-9a-f]{8})\]/g)) printed.add(match[1]);
  }
  return printed;
}