/**
 * `/memory` — the human's side of the memory.
 *
 * Everything the model can do to a memory it can do through a tool, and every
 * tool is reachable by anyone who can get the agent to listen. Export is not in
 * that category: writing the whole store to a path, or replacing beliefs from a
 * file, is an operator action, so it lives on the command surface where only the
 * person at the keyboard can reach it.
 *
 * @module dsh-hippo/commands
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { exportMemory, importMemory, describeDump } from './dump.js';
import { liveFacts, openLoops, spentToday, userId as readUserId } from './store.js';

/** Bilingual labels, because a command's output is read by a person, not a model. */
const WORDS = {
  zh: {
    usage: '用法：/memory [status|dump <文件>|import <文件>|inspect <文件>]',
    status: '记忆',
    episodes: '情景',
    facts: '事实',
    loops: '未了的事',
    spent: '今日模型开销',
    dumpWrote: '已导出',
    dumpRefused: '没有导出',
    importDone: '已导入',
    importRefused: '没有导入',
    inspect: '这个文件里有',
    omitted: '按设计不导出',
    redacted: '其中已被遗忘',
    refused: '因已遗忘而拒绝',
    includesRetired: '含已退休的',
    forgottenTalks: '句话已被遗忘',
    failed: '无法写入',
    refusedBecause: '群聊或陌生人不能操作记忆文件',
    unknown: '未知子命令',
  },
  en: {
    usage: 'usage: /memory [status|dump <file>|import <file>|inspect <file>]',
    status: 'memory',
    episodes: 'episodes',
    facts: 'facts',
    loops: 'open loops',
    spent: 'model tokens today',
    dumpWrote: 'wrote',
    dumpRefused: 'did not write',
    importDone: 'imported',
    importRefused: 'did not import',
    inspect: 'this file holds',
    omitted: 'not exported by design',
    redacted: 'of which forgotten',
    refused: 'refused as forgotten',
    includesRetired: 'including retired',
    forgottenTalks: 'sentences forgotten',
    failed: 'could not write',
    refusedBecause: 'a room or a stranger cannot touch memory files',
    unknown: 'unknown subcommand',
  },
};

/** Tables counted in `status`, in the order a person thinks about them. */
const COUNTED = ['episodes', 'facts', 'reflections', 'open_loops', 'evidence'];

/**
 * Run one `/memory` invocation.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ rawInput?: string, agent?: unknown }} invocation - what was typed, and from where.
 * @param {{ language?: 'zh'|'en', isOutsider?: (agent: unknown) => boolean }} [options] - deployment facts.
 * @returns {{ kind: 'success'|'error', text: string }} the command result.
 */
export function runMemoryCommand(db, invocation, options = {}) {
  const words = WORDS[options.language === 'en' ? 'en' : 'zh'];
  const raw = String(invocation?.rawInput ?? '').trim();
  const [verb = 'status', ...rest] = raw === '' ? ['status'] : raw.split(/\s+/);
  const target = rest.join(' ').trim();

  // The guard is on the operator verbs only. `status` is a count and reveals
  // nothing that the person reading it does not already own; a room asking for
  // counts is a room that has already been told too much.
  const operator = verb === 'dump' || verb === 'import';
  if (operator && options.isOutsider?.(invocation?.agent) === true) {
    return { kind: 'error', text: words.refusedBecause };
  }

  if (verb === 'status') {
    const counts = {};
    for (const table of COUNTED) {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    }
    const owner = readUserId(db);
    const live = liveFacts(db, { subject: owner, limit: 1000 }).length;
    const loops = openLoops(db, owner).length;
    const lines = [
      `${words.status}: ${counts.episodes} ${words.episodes} / ${live} ${words.facts} / ${loops} ${words.loops}`,
      `${words.spent}: ${spentToday(db)}`,
    ];
    return { kind: 'success', text: lines.join('\n') };
  }

  if (verb === 'dump') {
    if (target === '') return { kind: 'error', text: words.usage };
    const snapshot = exportMemory(db);
    try {
      writeFileSync(target, JSON.stringify(snapshot), 'utf8');
    } catch (error) {
      return { kind: 'error', text: `${words.dumpRefused}: ${String(error?.message ?? error)}` };
    }
    const described = describeDump(snapshot);
    // The counts here are rows in the file, not live beliefs, and the two differ
    // on purpose: `status` says 26 facts, this says 34, and both are right — a
    // dump carries the retired ones too, because "I used to believe this" is part
    // of the record. Say so rather than let two numbers about one store read as a
    // disagreement.
    return {
      kind: 'success',
      text: `${words.dumpWrote} ${target} — ${described.rows.episodes} ${words.episodes}, ${described.rows.facts} ${words.facts} (${words.includesRetired}), ${described.redactedEpisodes} ${words.forgottenTalks}`,
    };
  }

  if (verb === 'inspect') {
    if (target === '') return { kind: 'error', text: words.usage };
    const snapshot = readSnapshot(target);
    if (snapshot.error !== undefined) return { kind: 'error', text: snapshot.error };
    const described = describeDump(snapshot.snapshot);
    const rows = Object.entries(described.rows)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${table} ${count}`)
      .join(', ');
    return {
      kind: 'success',
      text: [
        `${words.inspect}: ${rows === '' ? '(empty)' : rows}`,
        `${words.redacted}: ${described.redactedEpisodes}`,
        `${words.omitted}: ${described.omitted.join(', ')}`,
      ].join('\n'),
    };
  }

  if (verb === 'import') {
    if (target === '') return { kind: 'error', text: words.usage };
    const read = readSnapshot(target);
    if (read.error !== undefined) return { kind: 'error', text: read.error };
    const report = importMemory(db, read.snapshot);
    if (report.ok !== true) return { kind: 'error', text: `${words.importRefused}: ${report.error}` };
    const added = Object.entries(report.added)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${table} +${count}`)
      .join(', ');
    const lines = [`${words.importDone}: ${added === '' ? '(nothing new)' : added}`];
    // Losses are reported or the report is a lie: a merge that dropped rows and
    // said nothing is indistinguishable from a clean one.
    if (report.refused.facts > 0 || report.refused.episodes > 0) {
      lines.push(`${words.refused}: ${report.refused.facts + report.refused.episodes}`);
    }
    const failed = Object.entries(report.failed)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${table} ${count}`)
      .join(', ');
    if (failed !== '') lines.push(`${words.failed}: ${failed}`);
    return { kind: 'success', text: lines.join('\n') };
  }

  return { kind: 'error', text: `${words.unknown}: ${verb}. ${words.usage}` };
}

/**
 * Read a dump file, turning every failure into a sentence rather than a throw.
 * @param {string} path - file to read.
 * @returns {{ snapshot: object, error?: undefined } | { error: string, snapshot?: undefined }} the outcome.
 */
function readSnapshot(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { error: `could not read ${path}: ${String(error?.message ?? error)}` };
  }
  try {
    return { snapshot: JSON.parse(text) };
  } catch (error) {
    return { error: `${path} is not JSON: ${String(error?.message ?? error)}` };
  }
}
