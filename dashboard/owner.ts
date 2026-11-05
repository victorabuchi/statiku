// Statiku's own account (Victor's): unlimited and never billed, with his websites in it under the keys their pages
// carry. Applied whenever the service starts and when that account signs up, so a new database, as after moving to
// another host, needs nothing done by hand. A site already added by hand for one of these domains takes the key.
import type pg from "pg";

export const OWNER = "contact@victorabuchi.com";
const SITES = [
  { key: "p_gzwvd7x7ta", name: "Notchlight", domain: "notchlight.com" },
  { key: "p_wpmmdvjkej", name: "Knewler", domain: "knewler.com" },
  { key: "p_babgy4em4p", name: "Victor Abuchi", domain: "victorabuchi.com" },
];

// The keys it set, so the ingest side can forget what it remembered about them; empty without the account.
export async function ownerSetup(pool: pg.Pool): Promise<string[]> {
  const { rows: [owner] } = await pool.query(
    `select m.workspace_id as id from memberships m join users u on u.id = m.user_id
      where u.email = $1 and m.role = 'owner' order by m.created_at limit 1`,
    [OWNER],
  );
  if (!owner) return [];
  await pool.query("update workspaces set plan = 'comp' where id = $1", [owner.id]);
  for (const s of SITES) {
    await pool.query(
      `with rekeyed as (
         update projects set key = $2
          where workspace_id = $1 and $4 = any(domains) and key <> $2 and not exists (select 1 from projects where key = $2)
         returning id)
       insert into projects (workspace_id, key, name, domains, timezone)
       select $1, $2, $3, array[$4], 'Europe/Helsinki'
        where not exists (select 1 from projects where workspace_id = $1 and $4 = any(domains))
          and not exists (select 1 from projects where key = $2)`,
      [owner.id, s.key, s.name, s.domain],
    );
  }
  return SITES.map((s) => s.key);
}
