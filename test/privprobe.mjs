import { openDatabase } from '../lib/db.js';
const db = await openDatabase(process.env.HIPPO_DB);
console.log('=== 每个会话里出现过的 speaker_id + 名字 + 条数 ===');
for (const r of db.prepare("SELECT session_id, speaker_id, speaker_name, COUNT(*) AS n, MAX(at) AS last FROM episodes WHERE speaker_id <> '' GROUP BY session_id, speaker_id ORDER BY last DESC").all()) {
  console.log(`  ${r.session_id}`);
  console.log(`      ${r.speaker_id} "${r.speaker_name}" x${r.n} last=${new Date(Number(r.last)).toISOString().slice(0,19)}`);
}
console.log('\n=== qq 会话总数 ===');
console.log(db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM episodes WHERE session_id LIKE 'qq:%'").get().n);
