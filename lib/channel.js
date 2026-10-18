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

/**
 * Whether the person on the far end of a direct session is the owner.
 *
 * This is the second half of the same leak, and it was hidden behind the first
 * one. `channelOf` correctly refuses to show the profile in a room. It happily
 * shows it in every direct conversation, on the reasoning that a direct
 * conversation is by construction with the owner. That reasoning survived
 * exactly as long as nobody else could message the bot.
 *
 * A companion running on a public instant-messaging account is reachable by
 * anyone who finds the number. When a stranger said hello, the agent greeted
 * them by the owner's name, mentioned the owner's week, and — worse — the
 * extractor filed the stranger's own words under `subject: user`, which in this
 * schema means the owner. A display name was overwritten by a stranger's
 * nickname and stayed that way. Nothing errored; every step did what it was
 * told.
 *
 * The question "is this the owner" cannot be answered from the transport. A
 * private chat proves that two parties are alone, not that one of them is
 * anybody in particular. So it is answered from configuration — `ownerIds` — and
 * the rule is deliberately one-sided: only an id that the deployment *named* can
 * be the owner, and everything else that can be identified is a stranger. A
 * session that cannot be identified at all (a terminal session, a uuid) is the
 * owner, because that is a person who already had to get onto this machine.
 *
 * @param {unknown} sessionId - the session id, or whatever the caller has.
 * @param {readonly string[]} ownerIds - the ids the deployment calls the owner.
 * @returns {'owner'|'stranger'} who is on the other end.
 */
export function audienceOf(sessionId, ownerIds) {
  const id = String(sessionId ?? '').trim();
  if (id === '') return 'owner';
  const known = Array.isArray(ownerIds) ? ownerIds.map((entry) => String(entry).trim()).filter((entry) => entry !== '') : [];
  if (known.length === 0) return 'owner';
  // Only direct channels are at stake; a room is never the owner speaking and is
  // handled before this is asked.
  const match = /:(?:private|direct):([^:]+)$/i.exec(id);
  if (match === null) return 'owner';
  return known.includes(match[1]) ? 'owner' : 'stranger';
}

/**
 * Who is being spoken to: the owner, a stranger on a direct channel, or a room.
 *
 * One function rather than two calls at each site, because the order matters and
 * getting it wrong is the whole bug. A group comes first: in a room nobody is the
 * owner, not even when the owner is the one typing, because everything said there
 * is said to everybody. Only a direct session can be the owner's, and only if
 * configuration names it.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {unknown} sessionId - the session id, or whatever the caller has.
 * @param {readonly string[]} ownerIds - the ids the deployment calls the owner.
 * @returns {'group'|'stranger'|'owner'} the audience.
 */
export function sceneOf(db, sessionId, ownerIds) {
  if (channelOf(db, sessionId) === 'group') return 'group';
  return audienceOf(sessionId, ownerIds);
}
