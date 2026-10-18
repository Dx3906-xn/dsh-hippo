/**
 * Which kind of room a session is.
 *
 * This exists because of a real leak. In a group of three the agent answered a
 * stranger with "晚晚，你今天忙不少吧？稿子交了" — the owner's name and the
 * owner's private business, said out loud to somebody who had only asked whether
 * the bot was listening. Nothing was wrong with the reply; the reply was exactly
 * what the prompt asked for. The prompt itself was the problem: the resident
 * profile is written for the person the agent belongs to, and it was being
 * pasted into every conversation the agent had with anyone.
 *
 * So every read path now asks this question first. `direct` is the answer unless
 * there is a reason to think otherwise, because being wrong that way costs some
 * recall and being wrong the other way costs somebody's privacy.
 *
 * @module
 */

/**
 * Whether a session is a group room or a direct conversation.
 *
 * Two sources, in order of authority:
 *
 *  1. What the store already recorded. This is the only real evidence, because
 *     it comes from the messages themselves rather than from a naming scheme.
 *  2. The session id's own shape. This is needed *before* any evidence exists:
 *     the always-present profile section is assembled before `agent/pre-step`
 *     runs, so on the first turn in a room the store is still empty for that
 *     session. Without this fallback the very first thing the agent says in a
 *     group is the one thing it says with a full profile of the owner.
 *
 * The id heuristic reads a bare `group` segment and nothing else. It is
 * deliberately narrow: `qq:onebot:group:1070071261` matches, while
 * `qq:onebot:private:3184763831` and a plain `session-<uuid>` do not. A channel
 * that names its sessions differently gets no protection from this branch and
 * has to wait one turn for the store — which is why the result is not cached
 * across assemblies: a session that starts out ambiguous should stop being
 * ambiguous as soon as it has content.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {unknown} sessionId - the session id, or whatever the caller has.
 * @returns {'direct'|'group'} the room kind.
 */
export function channelOf(db, sessionId) {
  const id = String(sessionId ?? '').trim();
  if (id === '' || id === 'unknown') return 'direct';
  try {
    const row = db.prepare(`
      SELECT 1 AS hit FROM episodes
      WHERE session_id = ? AND channel = 'group' LIMIT 1
    `).get(id);
    if (row !== undefined) return 'group';
  } catch {
    // A store too old to have the column cannot answer this way. The naming
    // rule below still can, so an unreadable store degrades instead of throwing
    // inside prompt assembly, where nothing would catch it.
  }
  return /(?:^|[^a-z])group(?:[^a-z]|$)/i.test(id) ? 'group' : 'direct';
}

/**
 * The session id an agent is working in.
 * @param {{ session?: { header?: { id?: unknown } } }} agent - the agent.
 * @returns {string} the id, or `'unknown'` when unavailable.
 */
export function sessionIdOf(agent) {
  const id = agent?.session?.header?.id;
  return id === undefined || id === null ? 'unknown' : String(id);
}
