// After restoring a backup into a new database, check it before switching to it: the rows in each table and the
// newest event, beside the live database's. In the service's Shell on Render:
//   npm run restore-check -- "<the restored database's internal URL>"
import pg from "pg";
import { dbConfig } from "../db/config.ts";

const restored = process.argv[2];
if (!process.env.DATABASE_URL || !restored) {
  console.log('Usage: npm run restore-check -- "<restored database URL>"   (DATABASE_URL is the live one)');
  process.exit(1);
}
const TABLES = ["users", "workspaces", "projects", "memberships", "sessions", "events", "installs", "imports", "imported_days", "usage_daily"];
async function look(url: string) {
  const client = new pg.Client(dbConfig(url));
  await client.connect();
  try {
    const counts: Record<string, string> = {};
    for (const t of TABLES) counts[t] = (await client.query(`select count(*)::text as n from ${t}`).catch(() => ({ rows: [{ n: "missing" }] }))).rows[0].n;
    const { rows: [newest] } = await client.query("select max(ts) as at from events");
    const { rows: [migrations] } = await client.query("select max(name) as last from schema_migrations");
    return { counts, newest: newest.at?.toISOString() ?? "none", migration: migrations.last };
  } finally {
    await client.end();
  }
}
const [live, copy] = await Promise.all([look(process.env.DATABASE_URL), look(restored)]);
console.log("table".padEnd(16), "live".padStart(12), "restored".padStart(12));
for (const t of TABLES) console.log(t.padEnd(16), live.counts[t].padStart(12), copy.counts[t].padStart(12));
console.log("newest event".padEnd(16), live.newest, copy.newest);
console.log("last migration".padEnd(16), live.migration, copy.migration);
const missing = TABLES.filter((t) => copy.counts[t] === "missing");
console.log(missing.length ? `The copy lacks ${missing.join(", ")}: run npm run migrate against it first.` : "Every table is there. Fewer rows in the copy is expected: it stops at the moment it was restored to.");
