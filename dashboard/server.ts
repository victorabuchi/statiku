// The dashboard: one page and a JSON API over the same Postgres the ingest service writes.
//   GET /                         the dashboard
//   GET /api/projects             projects, with when each last heard from its site
//   GET /api/stats?project=&range=today|d7|d30|d90&source=
// There are no accounts yet, so it listens on 127.0.0.1 only. Don't deploy it until sign-in exists.
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import pg from "pg";

const RANGES: Record<string, { days: number; unit: "hour" | "day" }> = {
  today: { days: 1, unit: "hour" },
  d7: { days: 7, unit: "day" },
  d30: { days: 30, unit: "day" },
  d90: { days: 90, unit: "day" },
};

// Every query takes the same parameters: project, from, to, source (or null for all), time zone.
const WHERE_EVENTS = "project_id = $1 and ts >= $2 and ts < $3 and ($4::text is null or source = $4)";
const WHERE_SESSIONS = "project_id = $1 and started_at >= $2 and started_at < $3 and ($4::text is null or source = $4)";

const TOTALS = `
  select
    (select count(*) from (select distinct visitor, (ts at time zone 'utc')::date from events
       where ${WHERE_EVENTS} and visitor is not null) v)::int as visitors,
    (select count(*) from events where ${WHERE_EVENTS} and name = 'pageview')::int as pageviews,
    (select count(distinct session_id) from events where ${WHERE_EVENTS} and name = 'download')::int as downloads,
    (select count(distinct session_id) from events where ${WHERE_EVENTS} and name = 'checkout')::int as checkouts,
    s.visits, s.bounce, s.duration
  from (select count(*)::int as visits,
               round(100.0 * count(*) filter (where events = 1) / nullif(count(*), 0))::int as bounce,
               coalesce(round(extract(epoch from avg(last_seen - started_at))), 0)::int as duration
          from sessions where ${WHERE_SESSIONS}) s`;

export async function stats(pool: pg.Pool, key: string, rangeId: string, source: string | null) {
  const project = (await pool.query("select id, key, name, domains, timezone from projects where key = $1", [key])).rows[0];
  if (!project) return null;
  const range = RANGES[rangeId] ?? RANGES.d30;
  const tz = project.timezone;

  // Day boundaries in the project's time zone: "7 days" is today and the 6 days before it.
  const { rows: [b] } = await pool.query(
    `select (date_trunc('day', now() at time zone $1) - make_interval(days => $2 - 1)) at time zone $1 as start, now() as now`,
    [tz, range.days],
  );
  const from: Date = b.start, to: Date = b.now;
  const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const p = [project.id, from, to, source];
  const q = async (sql: string, params: unknown[] = p) => (await pool.query(sql, params)).rows;

  const [totals] = await q(TOTALS);
  const [previous] = await q(TOTALS, [project.id, prevFrom, from, source]);

  const series = await q(
    `with buckets as (
       select generate_series(date_trunc($6, $2 at time zone $5), date_trunc($6, $3 at time zone $5), ('1 ' || $6)::interval) as t),
     e as (
       select date_trunc($6, ts at time zone $5) as t, count(distinct visitor)::int as visitors,
              (count(*) filter (where name = 'pageview'))::int as pageviews,
              (count(distinct session_id) filter (where name = 'download'))::int as downloads,
              (count(distinct session_id) filter (where name = 'checkout'))::int as checkouts
         from events where ${WHERE_EVENTS} group by 1),
     s as (
       select date_trunc($6, started_at at time zone $5) as t, count(*)::int as visits,
              round(100.0 * count(*) filter (where events = 1) / nullif(count(*), 0))::int as bounce,
              round(extract(epoch from avg(last_seen - started_at)))::int as duration
         from sessions where ${WHERE_SESSIONS} group by 1)
     select to_char(buckets.t, 'YYYY-MM-DD"T"HH24:MI') as t, coalesce(e.visitors, 0) as visitors, coalesce(e.pageviews, 0) as pageviews,
            coalesce(e.downloads, 0) as downloads, coalesce(e.checkouts, 0) as checkouts, coalesce(s.visits, 0) as visits,
            s.bounce, s.duration
       from buckets left join e using (t) left join s using (t) order by buckets.t`,
    [...p, tz, range.unit],
  );

  // Visitors in breakdowns count a visitor once per day, like the total.
  const visitorsBy = (column: string, extra = "") =>
    q(`select coalesce(${column}, 'Unknown') as label, count(distinct (visitor, (started_at at time zone 'utc')::date))::int as v
         from sessions where ${WHERE_SESSIONS} ${extra} group by 1 order by 2 desc, 1 limit 12`);

  const [sources, journeyBySource, topPages, entryPages, countries, devices, browsers, systems, events, [live], [last]] = await Promise.all([
    visitorsBy("source"),
    q(`with steps as (
         select session_id, bool_or(name = 'download') as download, bool_or(name = 'checkout') as checkout
           from events where ${WHERE_EVENTS} group by 1)
       select s.source as label, count(distinct (s.visitor, (s.started_at at time zone 'utc')::date))::int as visitors,
              count(*)::int as visits, (count(*) filter (where steps.download))::int as downloads,
              (count(*) filter (where steps.checkout))::int as checkouts
         from sessions s left join steps on steps.session_id = s.id
        where s.project_id = $1 and s.started_at >= $2 and s.started_at < $3 and ($4::text is null or s.source = $4)
        group by 1 order by 2 desc, 1 limit 20`),
    q(`select path as label, count(distinct visitor)::int as v, count(*)::int as pageviews from events
        where ${WHERE_EVENTS} and name = 'pageview' group by 1 order by 2 desc, 1 limit 12`),
    q(`select entry_path as label, count(*)::int as v from sessions where ${WHERE_SESSIONS} group by 1 order by 2 desc, 1 limit 12`),
    visitorsBy("country"),
    visitorsBy("device"),
    visitorsBy("browser"),
    visitorsBy("os"),
    q(`select e.name, count(*)::int as count, count(distinct e.session_id)::int as visits,
              (select string_agg(distinct k, ', ') from events e2 cross join lateral jsonb_object_keys(coalesce(e2.props, '{}')) k
                where e2.project_id = $1 and e2.ts >= $2 and e2.ts < $3 and ($4::text is null or e2.source = $4) and e2.name = e.name) as props
         from events e
        where e.project_id = $1 and e.ts >= $2 and e.ts < $3 and ($4::text is null or e.source = $4) and e.name <> 'pageview'
        group by 1 order by 2 desc limit 20`),
    q(`select count(distinct visitor)::int as n from events where project_id = $1 and ts > now() - interval '5 minutes'`, [project.id]),
    q(`select max(ts) as at from events where project_id = $1`, [project.id]),
  ]);

  return {
    project: { key: project.key, name: project.name, domains: project.domains, timezone: tz },
    range: { id: rangeId in RANGES ? rangeId : "d30", unit: range.unit, from, to },
    source,
    totals,
    previous,
    series,
    sources,
    journeyBySource,
    pages: { top: topPages, entry: entryPages },
    countries,
    devices: { device: devices, browser: browsers, os: systems },
    events,
    live: live.n,
    lastEventAt: last.at,
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

if (import.meta.main) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const page = () => readFileSync(new URL("index.html", import.meta.url));
  const ingestUrl = process.env.PUBLIC_URL ?? "http://localhost:8787";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(page());
      }
      if (url.pathname === "/api/projects") {
        const { rows } = await pool.query(
          `select p.key, p.name, p.domains, p.timezone, (select max(ts) from events e where e.project_id = p.id) as last_event_at
             from projects p order by p.created_at`,
        );
        return json(res, 200, { projects: rows, ingestUrl });
      }
      if (url.pathname === "/api/stats") {
        const data = await stats(pool, url.searchParams.get("project") ?? "", url.searchParams.get("range") ?? "d30", url.searchParams.get("source") || null);
        return data ? json(res, 200, data) : json(res, 404, { error: "No such project" });
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      console.error(e);
      json(res, 500, { error: (e as Error).message });
    }
  });
  const port = Number(process.env.DASHBOARD_PORT ?? 8788);
  server.listen(port, "127.0.0.1", () => console.log(`Statiku dashboard on http://localhost:${port}`));
}
