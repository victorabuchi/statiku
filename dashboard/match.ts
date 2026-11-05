// The match view: a site's day as a live scoreboard, for a TV on the wall or a launch day. Who's on the site now,
// today's visitors, goals (the events that matter: sign-ups, sales, downloads) and takings, its numbers, and the
// commentary: each goal and each new visit, latest first. It can be shared at a link of its own, which shows only this.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Session } from "../ingest/sessions.ts";
import { walkersOf } from "../ingest/live.ts";
import { numbersReport } from "./numbers.ts";
import { momentum } from "./insights.ts";
import { BILLING_COLUMNS } from "./billing.ts";
import type { Site } from "./stats.ts";

// Without a list of its own, these count as a site's goals, and so does anything that earned money.
export const DEFAULT_GOALS = ["signup", "sign_up", "register", "subscribe", "trial", "purchase", "order", "checkout", "download", "install", "lead", "contact"];
export const goalsOf = (site: { goals?: string[] | null }) => (site.goals?.length ? site.goals : DEFAULT_GOALS);
export const cleanGoals = (input: unknown): string[] | null => {
  if (input === null) return null;
  const list = (Array.isArray(input) ? input : String(input ?? "").split(","))
    .map((g) => String(g).trim().replace(/[\u0000-\u001f]/g, "").slice(0, 64)).filter(Boolean);
  return list.length ? [...new Set(list)].slice(0, 30) : null;
};

// Everything the match view shows, as of now.
export async function matchSummary(pool: pg.Pool, site: Site & { goals?: string[] | null }, present: Session[]) {
  const goals = goalsOf(site);
  const today = "date_trunc('day', now() at time zone $2) at time zone $2";
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  const [[totals], takings, commentary, numbers, wave] = await Promise.all([
    q(`select count(distinct visitor)::int as visitors, count(distinct session_id)::int as visits,
              (count(*) filter (where name = any($3) or revenue_minor is not null))::int as goals
         from events where project_id = $1 and ts >= ${today}`, [site.id, site.timezone, goals]),
    q(`select currency, sum(revenue_minor)::bigint as minor from events
        where project_id = $1 and ts >= ${today} and revenue_minor is not null group by 1 order by 2 desc`, [site.id, site.timezone]),
    // Each goal and each new visit today (an app's daily check-ins aren't news).
    q(`(select ts, name, path, source, country, revenue_minor as minor, currency, 'event' as kind from events
         where project_id = $1 and ts >= ${today} and name <> 'pageview' and name not in ('active', 'update', 'state')
         order by ts desc limit 60)
       union all
       (select started_at, null, entry_path, source, country, null, null, 'visit' from sessions
         where project_id = $1 and started_at >= ${today} order by started_at desc limit 60)
       order by 1 desc limit 60`, [site.id, site.timezone]),
    numbersReport(pool, site, "today"),
    momentum(pool, site),
  ]);
  return {
    site: { key: site.key, name: site.name, domain: site.domains[0], timezone: site.timezone },
    now: present.length,
    today: { ...totals, takings: takings.map((t) => ({ currency: t.currency, minor: Number(t.minor) })) },
    goals,
    commentary: commentary.map((c) => ({
      ts: c.ts, kind: c.kind, name: c.name, path: c.path, source: c.source, country: c.country,
      revenue: c.minor == null ? null : { minor: Number(c.minor), currency: c.currency },
      goal: c.kind === "event" && (goals.includes(c.name) || c.minor != null),
    })),
    numbers: numbers.numbers,
    momentum: wave,
    walkers: walkersOf(present),
  };
}

// A link of its own for the match view: anyone with it sees the scoreboard, and nothing else of the site.
export async function shareMatch(pool: pg.Pool, projectId: string) {
  const token = randomBytes(18).toString("base64url");
  await pool.query("update projects set match_token = $2 where id = $1", [projectId, token]);
  return token;
}
export const stopSharingMatch = (pool: pg.Pool, projectId: string) => pool.query("update projects set match_token = null where id = $1", [projectId]);

// The site a shared link shows, with what the match view needs of it.
export async function siteByMatchToken(pool: pg.Pool, token: string): Promise<(Site & { goals: string[] | null }) | null> {
  if (!/^[\w-]{20,40}$/.test(token)) return null;
  const { rows: [site] } = await pool.query(
    `select p.id, p.key, p.name, p.domains, p.timezone, 'viewer' as role, p.ask_location as "askLocation", p.alert_quiet as "alertQuiet",
            p.alert_surge as "alertSurge", p.workspace_id as "workspaceId", p.goals, ${BILLING_COLUMNS}
       from projects p join workspaces w on w.id = p.workspace_id where p.match_token = $1`,
    [token],
  );
  if (!site) return null;
  const { plan, status, trialEndsAt, periodEnd, cancelAtPeriodEnd, ...rest } = site;
  return { ...rest, billing: { plan, status, trialEndsAt, periodEnd, cancelAtPeriodEnd } };
}
