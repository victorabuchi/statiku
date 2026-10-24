// The numbers behind the dashboard: a site's analytics for a period, what's happening on it right now, and the
// overview of every site on the home page. All of it is read from the tables the ingest service writes.
import type pg from "pg";

export type Site = { id: string; key: string; name: string; domains: string[]; timezone: string };

// Each period, as local times in the site's time zone ($1). The previous period is the same span just before: for
// Today, yesterday up to the same hour.
const RANGES: Record<string, { from: string; to: string; length: string; unit: "hour" | "day" | "month" }> = {
  today: { from: "date_trunc('day', now() at time zone $1)", to: "now()", length: "1 day", unit: "hour" },
  yesterday: {
    from: "date_trunc('day', now() at time zone $1) - interval '1 day'",
    to: "date_trunc('day', now() at time zone $1) at time zone $1",
    length: "1 day",
    unit: "hour",
  },
  d7: { from: "date_trunc('day', now() at time zone $1) - interval '6 days'", to: "now()", length: "7 days", unit: "day" },
  d30: { from: "date_trunc('day', now() at time zone $1) - interval '29 days'", to: "now()", length: "30 days", unit: "day" },
  d90: { from: "date_trunc('day', now() at time zone $1) - interval '89 days'", to: "now()", length: "90 days", unit: "day" },
  m12: { from: "date_trunc('month', now() at time zone $1) - interval '11 months'", to: "now()", length: "12 months", unit: "month" },
};
export const RANGE_IDS = Object.keys(RANGES);

// Every query takes the same parameters: site, from, to, source (or null for all), time zone.
const WHERE_EVENTS = "project_id = $1 and ts >= $2 and ts < $3 and ($4::text is null or source = $4)";
const WHERE_SESSIONS = "project_id = $1 and started_at >= $2 and started_at < $3 and ($4::text is null or source = $4)";
const WHERE_INSTALLS = "project_id = $1 and ($4::text is null or source = $4)";

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

// The app in the same period: new installs (and how many matched no visit), installs used, trials started, licences.
const APP_TOTALS = `
  select
    (select count(*) from installs where ${WHERE_INSTALLS} and first_seen >= $2 and first_seen < $3)::int as installs,
    (select count(*) from installs where ${WHERE_INSTALLS} and first_seen >= $2 and first_seen < $3 and source is null)::int as unmatched,
    (select count(distinct install_id) from events where ${WHERE_EVENTS} and install_id is not null)::int as active,
    (select count(*) from installs where ${WHERE_INSTALLS} and trial_at >= $2 and trial_at < $3)::int as trials,
    (select count(*) from installs where ${WHERE_INSTALLS} and licensed_at >= $2 and licensed_at < $3)::int as licensed`;

// Every measure per hour, day or month ($6), with empty buckets as zeros.
const SERIES = `
  with buckets as (
    select generate_series(date_trunc($6, $2::timestamptz at time zone $5), date_trunc($6, ($3::timestamptz - interval '1 millisecond') at time zone $5), ('1 ' || $6)::interval) as t),
  e as (
    select date_trunc($6, ts at time zone $5) as t, count(distinct visitor)::int as visitors,
           (count(*) filter (where name = 'pageview'))::int as pageviews,
           (count(distinct session_id) filter (where name = 'download'))::int as downloads,
           (count(distinct session_id) filter (where name = 'checkout'))::int as checkouts,
           count(distinct install_id)::int as active
      from events where ${WHERE_EVENTS} group by 1),
  s as (
    select date_trunc($6, started_at at time zone $5) as t, count(*)::int as visits,
           round(100.0 * count(*) filter (where events = 1) / nullif(count(*), 0))::int as bounce,
           round(extract(epoch from avg(last_seen - started_at)))::int as duration
      from sessions where ${WHERE_SESSIONS} group by 1),
  i as (
    select date_trunc($6, at at time zone $5) as t, count(*) filter (where kind = 'install')::int as installs,
           count(*) filter (where kind = 'trial')::int as trials, count(*) filter (where kind = 'licensed')::int as licensed
      from installs cross join lateral (values ('install', first_seen), ('trial', trial_at), ('licensed', licensed_at)) k(kind, at)
     where ${WHERE_INSTALLS} and at >= $2 and at < $3 group by 1)
  select to_char(buckets.t, 'YYYY-MM-DD"T"HH24:MI') as t, coalesce(e.visitors, 0) as visitors, coalesce(e.pageviews, 0) as pageviews,
         coalesce(e.downloads, 0) as downloads, coalesce(e.checkouts, 0) as checkouts, coalesce(s.visits, 0) as visits,
         s.bounce, s.duration, coalesce(i.installs, 0) as installs, coalesce(e.active, 0) as active,
         coalesce(i.trials, 0) as trials, coalesce(i.licensed, 0) as licensed
    from buckets left join e using (t) left join s using (t) left join i using (t)
   order by buckets.t`;

// The SDK's own events, shown in the App section rather than among custom events.
const APP_LIFECYCLE = "('install', 'active', 'update', 'state')";

export async function siteFor(pool: pg.Pool, userId: string, key: string): Promise<Site | null> {
  const { rows: [site] } = await pool.query(
    `select p.id, p.key, p.name, p.domains, p.timezone from projects p
       join memberships m on m.workspace_id = p.workspace_id
      where p.key = $1 and m.user_id = $2`,
    [key, userId],
  );
  return site ?? null;
}

export async function stats(pool: pg.Pool, site: Site, rangeId: string, source: string | null) {
  const id = rangeId in RANGES ? rangeId : "d30";
  const range = RANGES[id];
  const tz = site.timezone;
  const { rows: [b] } = await pool.query(
    `select f at time zone $1 as "from", t as "to", (f - $2::interval) at time zone $1 as prev_from,
            ((f - $2::interval) at time zone $1) + (t - (f at time zone $1)) as prev_to
       from (select ${range.from} as f, ${range.to} as t) x`,
    [tz, range.length],
  );
  const p = [site.id, b.from, b.to, source];
  const prev = [site.id, b.prev_from, b.prev_to, source];
  const q = async (sql: string, params: unknown[] = p) => (await pool.query(sql, params)).rows;

  // Visitors in breakdowns count a visitor once per day, like the total.
  const visitorsBy = (column: string) =>
    q(`select coalesce(${column}, 'Unknown') as label, count(distinct (visitor, (started_at at time zone 'utc')::date))::int as v
         from sessions where ${WHERE_SESSIONS} group by 1 order by 2 desc, 1 limit 12`);
  // Installs used in the period, by what they last reported.
  const installsBy = (column: string) =>
    q(`select coalesce(${column}, 'Unknown') as label, count(*)::int as v from installs
        where ${WHERE_INSTALLS} and last_seen >= $2 and first_seen < $3 group by 1 order by 2 desc, 1 limit 12`);

  const [
    [totals], [previous], series, previousSeries, [appTotals], [appPrevious], sources, journeyBySource, [journeyApp],
    topPages, entryPages, exitPages, countries, devices, browsers, systems, campaigns, events, versions, states,
    appSystems, installSources, [appSeen], [last],
  ] = await Promise.all([
    q(TOTALS),
    q(TOTALS, prev),
    q(SERIES, [...p, tz, range.unit]),
    q(SERIES, [...prev, tz, range.unit]),
    q(APP_TOTALS),
    q(APP_TOTALS, prev),
    visitorsBy("source"),
    // The steps each visit took. An install counts for the visit whose download it was matched to.
    q(`with steps as (
         select session_id, bool_or(name = 'download') as download, bool_or(name = 'checkout') as checkout
           from events where ${WHERE_EVENTS} group by 1),
       inst as (
         select session_id, count(*) as installs, count(trial_at) as trials, count(licensed_at) as licensed
           from installs where project_id = $1 and session_id is not null and first_seen >= $2 group by 1)
       select s.source as label, count(distinct (s.visitor, (s.started_at at time zone 'utc')::date))::int as visitors,
              count(*)::int as visits, (count(*) filter (where steps.download))::int as downloads,
              (count(*) filter (where steps.checkout))::int as checkouts, coalesce(sum(inst.installs), 0)::int as installs,
              coalesce(sum(inst.trials), 0)::int as trials, coalesce(sum(inst.licensed), 0)::int as licensed
         from sessions s left join steps on steps.session_id = s.id left join inst on inst.session_id = s.id
        where s.project_id = $1 and s.started_at >= $2 and s.started_at < $3 and ($4::text is null or s.source = $4)
        group by 1 order by 2 desc, 1 limit 20`),
    q(`select count(*)::int as installs, count(i.trial_at)::int as trials, count(i.licensed_at)::int as licensed
         from installs i join sessions s on s.project_id = i.project_id and s.id = i.session_id
        where s.project_id = $1 and s.started_at >= $2 and s.started_at < $3 and ($4::text is null or s.source = $4)`),
    q(`select path as label, count(distinct visitor)::int as v, count(*)::int as pageviews from events
        where ${WHERE_EVENTS} and name = 'pageview' group by 1 order by 2 desc, 1 limit 12`),
    q(`select entry_path as label, count(*)::int as v from sessions where ${WHERE_SESSIONS} group by 1 order by 2 desc, 1 limit 12`),
    q(`select exit_path as label, count(*)::int as v from sessions where ${WHERE_SESSIONS} group by 1 order by 2 desc, 1 limit 12`),
    visitorsBy("country"),
    visitorsBy("device"),
    visitorsBy("browser"),
    visitorsBy("os"),
    q(`select utm_campaign as label, source, count(*)::int as v from sessions
        where ${WHERE_SESSIONS} and utm_campaign is not null group by 1, 2 order by 3 desc, 1 limit 12`),
    q(`select e.name, count(*)::int as count, count(distinct e.session_id)::int as visits,
              count(distinct e.install_id)::int as installs,
              (select string_agg(distinct k, ', ') from events e2 cross join lateral jsonb_object_keys(coalesce(e2.props, '{}')) k
                where e2.project_id = $1 and e2.ts >= $2 and e2.ts < $3 and ($4::text is null or e2.source = $4) and e2.name = e.name) as props
         from events e
        where e.project_id = $1 and e.ts >= $2 and e.ts < $3 and ($4::text is null or e.source = $4) and e.name <> 'pageview'
          and not (e.install_id is not null and e.name in ${APP_LIFECYCLE})
        group by 1 order by 2 desc limit 20`),
    installsBy("app_version"),
    installsBy("state"),
    installsBy("platform || ' ' || split_part(os_version, '.', 1)"),
    q(`select coalesce(source, 'Not matched') as label, count(*)::int as v from installs
        where ${WHERE_INSTALLS} and first_seen >= $2 and first_seen < $3 group by 1 order by 2 desc, 1 limit 12`),
    q(`select max(last_seen) as at from installs where project_id = $1`, [site.id]),
    q(`select ts as at from events where project_id = $1 order by ts desc limit 1`, [site.id]),
  ]);

  return {
    site: { key: site.key, name: site.name, domains: site.domains, timezone: tz },
    range: { id, unit: range.unit, from: b.from, to: b.to, prevFrom: b.prev_from, prevTo: b.prev_to },
    source,
    totals,
    previous,
    series,
    previousSeries,
    sources,
    journeyBySource,
    pages: { top: topPages, entry: entryPages, exit: exitPages },
    countries,
    devices: { device: devices, browser: browsers, os: systems },
    campaigns,
    events,
    app: {
      has: appSeen.at !== null,
      lastSeen: appSeen.at,
      totals: appTotals,
      previous: appPrevious,
      journey: journeyApp,
      versions,
      states,
      systems: appSystems,
      sources: installSources,
    },
    lastEventAt: last?.at ?? null,
  };
}

// Right now: the visits seen in the last five minutes, where they are and what they're reading, today's totals,
// page views minute by minute for the last half hour, and the latest events. No visitor hash leaves the server.
export async function live(pool: pg.Pool, site: Site) {
  const tz = site.timezone;
  const q = async (sql: string, params: unknown[] = [site.id]) => (await pool.query(sql, params)).rows;
  // A visit can't have started more than a day ago (the visitor hash changes daily), which keeps this on recent partitions.
  const NOW = "project_id = $1 and started_at > now() - interval '1 day' and last_seen > now() - interval '5 minutes'";
  const by = (column: string) =>
    q(`select coalesce(${column}, 'Unknown') as label, count(distinct visitor)::int as v from sessions where ${NOW} group by 1 order by 2 desc, 1 limit 10`);
  const [[now], countries, pages, sources, devices, [today], perMinute, recent] = await Promise.all([
    q(`select count(distinct visitor)::int as visitors from sessions where ${NOW}`),
    by("country"),
    by("exit_path"),
    by("source"),
    by("device"),
    q(`select count(distinct visitor)::int as visitors, (count(*) filter (where name = 'pageview'))::int as pageviews,
              count(distinct session_id)::int as visits, (count(distinct session_id) filter (where name = 'download'))::int as downloads
         from events where project_id = $1 and ts >= date_trunc('day', now() at time zone $2) at time zone $2`, [site.id, tz]),
    q(`select to_char(m at time zone $2, 'HH24:MI') as t, coalesce(n, 0)::int as v
         from generate_series(date_trunc('minute', now()) - interval '29 minutes', date_trunc('minute', now()), interval '1 minute') m
         left join (select date_trunc('minute', ts) as m, count(*) as n from events
                     where project_id = $1 and ts > now() - interval '31 minutes' and name = 'pageview' group by 1) e using (m)
        order by m`, [site.id, tz]),
    q(`select ts, name, path, country, source, device, browser, os, install_id is not null as app
         from events where project_id = $1 and ts > now() - interval '30 minutes' order by ts desc limit 25`),
  ]);
  return { visitors: now.visitors, countries, pages, sources, devices, today, perMinute, recent, at: new Date() };
}

// Every site the person can see, with today's numbers, who's on it now and a fortnight of daily visitors.
export async function overview(pool: pg.Pool, userId: string) {
  const { rows: sites } = await pool.query(
    `select p.id, p.key, p.name, p.domains, p.timezone, p.created_at,
            (select ts from events e where e.project_id = p.id order by ts desc limit 1) as last_event_at,
            (select count(distinct visitor) from sessions s where s.project_id = p.id and s.started_at > now() - interval '1 day'
                and s.last_seen > now() - interval '5 minutes')::int as live
       from projects p join memberships m on m.workspace_id = p.workspace_id
      where m.user_id = $1 order by p.created_at`,
    [userId],
  );
  if (!sites.length) return [];
  const { rows: days } = await pool.query(
    `select e.project_id, to_char((e.ts at time zone p.timezone)::date, 'YYYY-MM-DD') as day,
            count(distinct e.visitor)::int as visitors, (count(*) filter (where e.name = 'pageview'))::int as pageviews
       from events e join projects p on p.id = e.project_id
      where e.project_id = any($1) and e.ts > now() - interval '15 days' and e.visitor is not null
      group by 1, 2`,
    [sites.map((s) => s.id)],
  );
  return sites.map((s) => {
    // The last 14 days in the site's own time zone, today last.
    const today = new Date(new Date().toLocaleString("en-US", { timeZone: s.timezone }));
    const keys = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (13 - i));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    const mine = new Map(days.filter((d) => d.project_id === s.id).map((d) => [d.day, d]));
    const spark = keys.map((k) => mine.get(k)?.visitors ?? 0);
    const todayRow = mine.get(keys[13]);
    return {
      key: s.key, name: s.name, domains: s.domains, timezone: s.timezone, createdAt: s.created_at, lastEventAt: s.last_event_at,
      live: s.live, visitorsToday: todayRow?.visitors ?? 0, pageviewsToday: todayRow?.pageviews ?? 0, spark,
    };
  });
}
