// Projects from the command line, until the dashboard exists.
//   npm run project -- create "Notchlight" notchlight.com [--timezone Europe/Helsinki]
//   npm run project -- domains <key> notchlight.com www.notchlight.com
//   npm run project -- list
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";
import { cleanDomain } from "../ingest/projects.ts";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const newKey = () => "p_" + [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");

export async function createProject(pool: pg.Pool, name: string, domains: string[], timezone = "UTC") {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workspace = (await client.query("insert into workspaces (name) values ($1) returning id", [name])).rows[0];
    const project = (
      await client.query(
        "insert into projects (workspace_id, key, name, domains, timezone) values ($1, $2, $3, $4, $5) returning id, key, name, domains, timezone",
        [workspace.id, newKey(), name, domains.map(cleanDomain), timezone],
      )
    ).rows[0];
    await client.query("commit");
    return project;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const snippet = (key: string) =>
  `<script defer data-project="${key}" src="${process.env.PUBLIC_URL ?? "http://localhost:8787"}/s.js"></script>`;

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { timezone: { type: "string" } } });
  const [command, ...rest] = positionals;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (command === "create" && rest.length >= 2) {
      const [name, ...domains] = rest;
      const p = await createProject(pool, name, domains, values.timezone);
      console.log(`${p.name}: ${p.key}, domains ${p.domains.join(", ")}, time zone ${p.timezone}\n\n${snippet(p.key)}`);
    } else if (command === "domains" && rest.length >= 2) {
      const [key, ...domains] = rest;
      const { rowCount } = await pool.query("update projects set domains = $2 where key = $1", [key, domains.map(cleanDomain)]);
      console.log(rowCount ? `${key}: ${domains.map(cleanDomain).join(", ")}` : `No project ${key}`);
    } else if (command === "list") {
      const { rows } = await pool.query("select key, name, domains, timezone from projects order by created_at");
      for (const p of rows) console.log(`${p.key}  ${p.name}  ${p.domains.join(", ")}  ${p.timezone}`);
    } else {
      console.log('Usage: npm run project -- create <name> <domain>… [--timezone Europe/Helsinki] | domains <key> <domain>… | list');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
