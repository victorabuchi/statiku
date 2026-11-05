// Applies db/migrations/*.sql in order, once each. Run: npm run migrate
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { dbConfig } from "./config.ts";

// A database that was just created or restarted refuses connections for a while; a deploy waits for it, up to five
// minutes, rather than failing.
const NOT_READY = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P03", "connection timeout"];

async function connect(connectionString: string, log: (...args: unknown[]) => void) {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const client = new pg.Client(dbConfig(connectionString, { connectionTimeoutMillis: 20_000 }));
    try {
      await client.connect();
      return client;
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      if (Date.now() > deadline || !NOT_READY.some((c) => code.includes(c))) throw e;
      log(`The database isn't ready yet (${code}); trying again in 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

export async function migrate(connectionString: string, log = console.log) {
  const client = await connect(connectionString, log);
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
