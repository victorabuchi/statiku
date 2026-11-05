// Projects from the command line, until the dashboard exists.
//   npm run project -- create "Notchlight" notchlight.com [--timezone Europe/Helsinki]
//   npm run project -- domains <key> notchlight.com www.notchlight.com
//   npm run project -- list
//   npm run project -- move <key> <email>    into that person's account, for projects made here before accounts
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";
import { dbConfig } from "../db/config.ts";
import { cleanDomain } from "../ingest/projects.ts";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const newKey = () => "p_" + [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");

// A project in the given workspace, or, from the command line, in a workspace of its own.
export async function createProject(pool: pg.Pool, name: string, domains: string[], timezone = "UTC", workspaceId?: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    workspaceId ??= (await client.query("insert into workspaces (name) values ($1) returning id", [name])).rows[0].id as string;
    const project = (
      await client.query(
        "insert into projects (workspace_id, key, name, domains, timezone) values ($1, $2, $3, $4, $5) returning id, key, name, domains, timezone",
        [workspaceId, newKey(), name, domains.map(cleanDomain), timezone],
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

// On Render (in the service's Shell) the service's own address; locally the dev server.
// A project and everything it collected. Events, sessions and marks are partitioned or short-lived, so they have no
// foreign key to cascade from; a workspace left with no projects and no members goes too.
export async function deleteProject(pool: pg.Pool, projectId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const table of ["events", "sessions", "download_marks", "metric_points", "clicks", "scrolls", "vitals", "page_errors"]) await client.query(`delete from ${table} where project_id = $1`, [projectId]);
    const { rows: [gone] } = await client.query("delete from projects where id = $1 returning workspace_id", [projectId]);
    if (gone) {
      await client.query(
        `delete from workspaces w where id = $1 and not exists (select 1 from projects where workspace_id = w.id)
            and not exists (select 1 from memberships where workspace_id = w.id)`,
        [gone.workspace_id],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const snippet = (key: string) =>
  `<script defer data-project="${key}" src="${process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:8787"}/s.js"></script>`;

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { timezone: { type: "string" } } });
  const [command, ...rest] = positionals;
  const pool = new pg.Pool(dbConfig(process.env.DATABASE_URL!));
  try {
    if (command === "create" && rest.length >= 2) {
      const [name, ...domains] = rest;
      const p = await createProject(pool, name, domains, values.timezone);
      console.log(`${p.name}: ${p.key}, domains ${p.domains.join(", ")}, time zone ${p.timezone}\n\n${snippet(p.key)}`);
    } else if (command === "domains" && rest.length >= 2) {
      const [key, ...domains] = rest;
      const { rowCount } = await pool.query("update projects set domains = $2 where key = $1", [key, domains.map(cleanDomain)]);
      console.log(rowCount ? `${key}: ${domains.map(cleanDomain).join(", ")}` : `No project ${key}`);
    } else if (command === "move" && rest.length === 2) {
      const [key, email] = rest;
      const { rows: [target] } = await pool.query(
        `select m.workspace_id from memberships m join users u on u.id = m.user_id
          where u.email = lower($1) and m.role = 'owner' order by m.created_at limit 1`,
        [email],
      );
      const { rows: [moved] } = target
        ? await pool.query("update projects set workspace_id = $2 where key = $1 returning name, workspace_id", [key, target.workspace_id])
        : { rows: [] };
      // The workspace it leaves behind, made for it alone, goes if nothing else is in it.
      await pool.query(
        `delete from workspaces w where not exists (select 1 from projects where workspace_id = w.id)
            and not exists (select 1 from memberships where workspace_id = w.id)`,
      );
      console.log(!target ? `No account for ${email}; sign up first.` : moved ? `${moved.name} (${key}) is now in ${email}'s account.` : `No project ${key}`);
    } else if (command === "list") {
      const { rows } = await pool.query("select key, name, domains, timezone from projects order by created_at");
      for (const p of rows) console.log(`${p.key}  ${p.name}  ${p.domains.join(", ")}  ${p.timezone}`);
    } else {
      console.log('Usage: npm run project -- create <name> <domain>… [--timezone Europe/Helsinki] | domains <key> <domain>… | move <key> <email> | list');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
