// Applies db/migrations/*.sql in order, once each. Run: npm run migrate
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

export async function migrate(connectionString: string, log = console.log) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    const dir = new URL("migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(new URL(file, dir), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        log("applied", file);
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
  await migrate(process.env.DATABASE_URL);
}
