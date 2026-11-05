// Billing by hand, in the service's Shell on Render:
//   npm run billing -- comp you@example.com          a plan for free, for the workspaces this person owns
//   npm run billing -- trial you@example.com 14      their trial ends 14 days from now
//   npm run billing -- show you@example.com
import pg from "pg";
import { dbConfig } from "../db/config.ts";

const [command, email, days] = process.argv.slice(2);
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
if (!["comp", "trial", "show"].includes(command) || !email) {
  console.log("Usage: npm run billing -- comp <email> | trial <email> <days> | show <email>");
  process.exit(1);
}
const pool = new pg.Pool(dbConfig(process.env.DATABASE_URL!));
const owned = `select m.workspace_id from memberships m join users u on u.id = m.user_id where u.email = lower($1) and m.role = 'owner'`;
if (command === "comp") await pool.query(`update workspaces set plan = 'comp' where id in (${owned})`, [email]);
if (command === "trial") await pool.query(`update workspaces set trial_ends_at = now() + make_interval(days => $2) where id in (${owned})`, [email, Number(days) || 30]);
const { rows } = await pool.query(
  `select w.name, w.plan, w.trial_ends_at, w.subscription_status, w.period_end from workspaces w where w.id in (${owned})`,
  [email],
);
if (!rows.length) console.log(`${email} owns no workspace.`);
for (const w of rows) console.log(`${w.name}: plan ${w.plan}, trial until ${w.trial_ends_at?.toISOString() ?? "–"}, subscription ${w.subscription_status ?? "none"}${w.period_end ? ` until ${w.period_end.toISOString()}` : ""}`);
await pool.end();
