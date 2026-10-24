// The numbers behind the dashboard: a site's analytics for a period, what's happening on it right now, and the
// overview of every site on the home page. Periods are read from the tables the ingest service writes; "right now"
// comes from the visits it holds in memory, so arrivals and departures show at once.
import type pg from "pg";
import type { Session } from "../ingest/sessions.ts";
import { addressOf, type Street, type Streets } from "../ingest/streets.ts";
import { BILLING_COLUMNS, type Billing } from "./billing.ts";

export type Site = {
  id: string; key: string; name: string; domains: string[]; timezone: string; role: string; askLocation: boolean; alertQuiet: boolean; alertSurge: boolean;
  workspaceId: string; billing: Billing;
};
export type Presence = (projectId: string) => Session[];

// Narrowing a report to one value of a breakdown. A page means the visits that viewed that page.
export const FILTERS = ["source", "country", "device", "browser", "os", "page"] as const;
export type Filters = Record<(typeof FILTERS)[number], string | null>;

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
export const RANGE_IDS = [...Object.keys(RANGES), "custom", "all"];

// The buckets a chart can be drawn in. A request for one that would make more than 1,500 points gets the period's own.
export const UNITS = ["hour", "day", "week", "month", "year"] as const;
const UNIT_MS: Record<string, number> = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

// Every query takes the same parameters: site, from, to, then each filter or null: source ($4), country ($5),
// device ($6), browser ($7), system ($8) and page ($9). Installs have only a source and a country to filter by.
const PAGE_VISITS = "(select session_id from events where project_id = $1 and ts >= $2 and ts < $3::timestamptz + interval '1 day' and name = 'pageview' and path = $9)";
const DIMENSIONS = `($4::text is null or source = $4) and ($5::text is null or country = $5) and ($6::text is null or device = $6)
  and ($7::text is null or browser = $7) and ($8::text is null or os = $8)`;
const WHERE_EVENTS = `project_id = $1 and ts >= $2 and ts < $3 and ${DIMENSIONS} and ($9::text is null or session_id in ${PAGE_VISITS})`;
const WHERE_SESSIONS = `project_id = $1 and started_at >= $2 and started_at < $3 and ${DIMENSIONS} and ($9::text is null or id in ${PAGE_VISITS})`;
const WHERE_INSTALLS = "project_id = $1 and ($4::text is null or source = $4) and ($5::text is null or country = $5)";

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

// Every measure per hour, day or month ($11) in the site's time zone ($10), with empty buckets as zeros.
const SERIES = `
  with buckets as (
    select generate_series(date_trunc($11, $2::timestamptz at time zone $10), date_trunc($11, ($3::timestamptz - interval '1 millisecond') at time zone $10), ('1 ' || $11)::interval) as t),
  e as (
    select date_trunc($11, ts at time zone $10) as t, count(distinct visitor)::int as visitors,
           (count(*) filter (where name = 'pageview'))::int as pageviews,
           (count(distinct session_id) filter (where name = 'download'))::int as downloads,
           (count(distinct session_id) filter (where name = 'checkout'))::int as checkouts,
           count(distinct install_id)::int as active
      from events where ${WHERE_EVENTS} group by 1),
  s as (
    select date_trunc($11, started_at at time zone $10) as t, count(*)::int as visits,
           round(100.0 * count(*) filter (where events = 1) / nullif(count(*), 0))::int as bounce,
           round(extract(epoch from avg(last_seen - started_at)))::int as duration
      from sessions where ${WHERE_SESSIONS} group by 1),
  i as (
    select date_trunc($11, at at time zone $10) as t, count(*) filter (where kind = 'install')::int as installs,
           count(*) filter (where kind = 'trial')::int as trials, count(*) filter (where kind = 'licensed')::int as licensed
      from installs cross join lateral (values ('install', first_seen), ('trial', trial_at), ('licensed', licensed_at)) k(kind, at)
     where ${WHERE_INSTALLS} and at >= $2 and at < $3 group by 1)
  select to_char(buckets.t, 'YYYY-MM-DD"T"HH24:MI') as t, coalesce(e.visitors, 0) as visitors, coalesce(e.pageviews, 0) as pageviews,
         coalesce(e.downloads, 0) as downloads, coalesce(e.checkouts, 0) as checkouts, coalesce(s.visits, 0) as visits,
         s.bounce, s.duration, coalesce(i.installs, 0) as installs, coalesce(e.active, 0) as active,
         coalesce(i.trials, 0) as trials, coalesce(i.licensed, 0) as licensed
    from buckets left join e using (t) left join s using (t) left join i using (t)
   order by buckets.t`;

// History brought in from another tool (imports.ts): it counts for the days before Statiku's own first event on the
// site ($6), in the site's time zone ($5), for one breakdown ($4), and only in reports nothing narrows, since another
// tool's numbers can't be narrowed by Statiku's filters.
const IMPORTED_ROWS = `
  from imported_days d join imports i on i.id = d.import_id and i.status = 'done'
 where d.project_id = $1 and d.dimension = $4 and d.day >= ($2::timestamptz at time zone $5)::date
   and d.day <= (($3::timestamptz - interval '1 millisecond') at time zone $5)::date and d.day < $6::date`;
const IMPORTED_SUMS = `coalesce(sum(visitors), 0)::int as visitors, coalesce(sum(visits), 0)::int as visits,
  coalesce(sum(pageviews), 0)::int as pageviews, coalesce(sum(bounces), 0)::int as bounces, coalesce(sum(duration), 0)::float as duration,
  coalesce(sum(measured), 0)::int as measured`;

type Sums = { visitors: number; visits: number; pageviews: number; bounces: number; duration: number; measured: number };
type Totals = { visitors: number; pageviews: number; visits: number; bounce: number | null; duration: number | null };

// Statiku's own numbers and imported ones together. Every visit Statiku counted has a bounce and a duration; imported
// visits only when the other tool said.
function withImported<T extends Totals>(own: T, imported: Sums | undefined): T {
  if (!imported || !(imported.visitors || imported.visits || imported.pageviews)) return own;
  const measured = own.visits + imported.measured;
  return {
    ...own,
    visitors: own.visitors + imported.visitors,
    pageviews: own.pageviews + imported.pageviews,
    visits: own.visits + imported.visits,
    bounce: measured ? Math.round((((own.bounce ?? 0) / 100) * own.visits + imported.bounces) * 100 / measured) : own.bounce,
    duration: measured ? Math.round(((own.duration ?? 0) * own.visits + imported.duration) / measured) : own.duration,
  };
}

// A breakdown with imported rows added in, most first.
function mergeRows<T extends { label: string; v: number; pageviews?: number }>(own: T[], imported: { label: string; v: number; pageviews: number }[], limit = 12): T[] {
  if (!imported.length) return own;
  const rows = new Map(own.map((r) => [r.label, { ...r }]));
  for (const r of imported) {
    const had = rows.get(r.label);
    if (had) {
      had.v += r.v;
      if (had.pageviews !== undefined) had.pageviews += r.pageviews;
    } else rows.set(r.label, { label: r.label, v: r.v, ...(own[0]?.pageviews !== undefined || r.pageviews ? { pageviews: r.pageviews } : {}) } as unknown as T);
  }
  return [...rows.values()].filter((r) => r.v > 0).sort((a, b) => b.v - a.v || a.label.localeCompare(b.label)).slice(0, limit);
}

// The SDK's own events, shown in the App section rather than among custom events.
const APP_LIFECYCLE = "('install', 'active', 'update', 'state')";

export async function siteFor(pool: pg.Pool, userId: string, key: string): Promise<Site | null> {
  const { rows: [site] } = await pool.query(
    `select p.id, p.key, p.name, p.domains, p.timezone, m.role, p.ask_location as "askLocation", p.alert_quiet as "alertQuiet", p.alert_surge as "alertSurge",
            p.workspace_id as "workspaceId", ${BILLING_COLUMNS}
       from projects p join memberships m on m.workspace_id = p.workspace_id join workspaces w on w.id = p.workspace_id
      where p.key = $1 and m.user_id = $2`,
    [key, userId],
  );
  if (!site) return null;
  const { plan, status, trialEndsAt, periodEnd, cancelAtPeriodEnd, ...rest } = site;
  return { ...rest, billing: { plan, status, trialEndsAt, periodEnd, cancelAtPeriodEnd } };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A period's bounds and the previous period of the same length. A custom period runs from the start of its first
// day to the end of its last (or now, if that's sooner), by hour for one day, by month past six months. All time runs
// from the day of the site's first visit (or first imported day), and has nothing before it to compare with.
async function bounds(pool: pg.Pool, siteId: string, tz: string, rangeId: string, custom: { from?: string | null; to?: string | null }) {
  if (rangeId === "all") {
    const { rows: [b] } = await pool.query(
      `select f at time zone $1 as "from", now() as "to"
         from (select date_trunc('day', least(
                 coalesce((select min(ts) from events where project_id = $2), (select created_at from projects where id = $2)) at time zone $1,
                 coalesce((select min(d.day)::timestamp from imported_days d join imports i on i.id = d.import_id and i.status = 'done'
                            where d.project_id = $2), 'infinity'))) as f) x`,
      [tz, siteId],
    );
    const days = (b.to - b.from) / 86400e3;
    const unit = days <= 2 ? "hour" : days <= 180 ? "day" : days <= 730 ? "week" : "month";
    return { id: "all", unit, from: b.from, to: b.to, prevFrom: b.from, prevTo: b.from };
  }
  if (rangeId === "custom" && DAY.test(custom.from ?? "") && DAY.test(custom.to ?? "")) {
    const { rows: [b] } = await pool.query(
      `select f at time zone $1 as "from", least((t + interval '1 day') at time zone $1, now()) as "to", n,
              (f - make_interval(days => n)) at time zone $1 as prev_from
         from (select least($2::date, $3::date)::timestamp as f, greatest($2::date, $3::date)::timestamp as t,
                      abs($3::date - $2::date) + 1 as n) x`,
      [tz, custom.from, custom.to],
    );
    if (b.n <= 732 && b.from < b.to) {
      const unit = b.n === 1 ? "hour" : b.n > 180 ? "month" : "day";
      return { id: "custom", unit, from: b.from, to: b.to, prevFrom: b.prev_from, prevTo: new Date(b.prev_from.getTime() + (b.to - b.from)) };
    }
  }
  const id = rangeId in RANGES ? rangeId : "d30";
  const range = RANGES[id];
  const { rows: [b] } = await pool.query(
    `select f at time zone $1 as "from", t as "to", (f - $2::interval) at time zone $1 as prev_from,
            ((f - $2::interval) at time zone $1) + (t - (f at time zone $1)) as prev_to
       from (select ${range.from} as f, ${range.to} as t) x`,
    [tz, range.length],
  );
  return { id, unit: range.unit, from: b.from, to: b.to, prevFrom: b.prev_from, prevTo: b.prev_to };
}

export async function stats(pool: pg.Pool, site: Site, rangeId: string, filters: Filters, custom: { from?: string | null; to?: string | null; by?: string | null } = {}) {
  const tz = site.timezone;
  const b = await bounds(pool, site.id, tz, rangeId, custom);
  const asked = custom.by as (typeof UNITS)[number] | undefined;
  if (asked && UNITS.includes(asked) && (b.to.getTime() - b.from.getTime()) / UNIT_MS[asked] <= 1500) b.unit = asked;
  const narrow = FILTERS.map((f) => filters[f]);
  const p = [site.id, b.from, b.to, ...narrow];
  const prev = [site.id, b.prevFrom, b.prevTo, ...narrow];
  // Queries on installs alone take only the filters installs have.
  const pi = [site.id, b.from, b.to, filters.source, filters.country];
  const q = async (sql: string, params: unknown[] = p) => (await pool.query(sql, params)).rows;

  // Visitors in breakdowns count a visitor once per day, like the total.
  const visitorsBy = (column: string) =>
    q(`select coalesce(${column}, 'Unknown') as label, count(distinct (visitor, (started_at at time zone 'utc')::date))::int as v
         from sessions where ${WHERE_SESSIONS} group by 1 order by 2 desc, 1 limit 12`);
  // Installs used in the period, by what they last reported.
  const installsBy = (column: string) =>
    q(`select coalesce(${column}, 'Unknown') as label, count(*)::int as v from installs
        where ${WHERE_INSTALLS} and last_seen >= $2 and first_seen < $3 group by 1 order by 2 desc, 1 limit 12`, pi);

  // Imported history: which imports the site has, and the day Statiku's own counting began.
  const [{ rows: importsDone }, { rows: [own] }] = await Promise.all([
    pool.query("select kind, label, first_day::text as first, last_day::text as last from imports where project_id = $1 and status = 'done' order by created_at", [site.id]),
    pool.query("select (min(ts) at time zone $2)::date::text as day from events where project_id = $1", [site.id, tz]),
  ]);
  const history = importsDone.filter((s) => s.kind !== "github");
  const narrowed = FILTERS.some((f) => filters[f]);
  const withHistory = history.length > 0 && !narrowed;
  const before = own?.day ?? "infinity";
  const imp = (sql: string, dimension: string, from: Date, to: Date, extra: unknown[] = []) =>
    withHistory ? q(sql, [site.id, from, to, dimension, tz, before, ...extra]) : Promise.resolve([]);
  const importedBy = (dimension: string) =>
    imp(`select value as label, coalesce(sum(case when $4 = 'entry' then visits else visitors end), 0)::int as v, coalesce(sum(pageviews), 0)::int as pageviews
           ${IMPORTED_ROWS} group by 1`, dimension, b.from, b.to);
  const seriesOf = (sql: string, from: Date, to: Date) => imp(sql, "total", from, to, [b.unit]);
  const IMPORTED_SERIES = `select to_char(date_trunc($7, d.day::timestamp), 'YYYY-MM-DD"T"HH24:MI') as t, ${IMPORTED_SUMS} ${IMPORTED_ROWS} group by 1`;
  // GitHub's release downloads, a measure of their own: all time by release, and in the period by day.
  const github = importsDone.some((s) => s.kind === "github");
  const downloads = (sql: string, params: unknown[]) => (github ? q(sql, params) : Promise.resolve([]));

  const [
    [totals], [previous], series, previousSeries, [appTotals], [appPrevious], sources, journeyBySource, [journeyApp],
    topPages, entryPages, exitPages, countries, devices, browsers, systems, campaigns, events, versions, states,
    appSystems, installSources, [appSeen], [last],
    [importedTotals], [importedPrevious], importedSeries, importedPreviousSeries, importedSources, importedPages, importedEntries,
    importedCountries, importedDevices, importedBrowsers, importedSystems,
    releasesAll, [releasesPeriod], releasesSeries,
  ] = await Promise.all([
    q(TOTALS),
    q(TOTALS, prev),
    q(SERIES, [...p, tz, b.unit]),
    q(SERIES, [...prev, tz, b.unit]),
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
         from (select * from sessions where ${WHERE_SESSIONS}) s left join steps on steps.session_id = s.id
         left join inst on inst.session_id = s.id
        group by 1 order by 2 desc, 1 limit 20`),
    q(`select count(*)::int as installs, count(i.trial_at)::int as trials, count(i.licensed_at)::int as licensed
         from installs i join (select * from sessions where ${WHERE_SESSIONS}) s on s.project_id = i.project_id and s.id = i.session_id`),
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
    q(`with ev as (
         select name, session_id, install_id, props from events
          where ${WHERE_EVENTS} and name <> 'pageview' and not (install_id is not null and name in ${APP_LIFECYCLE}))
       select name, count(*)::int as count, count(distinct session_id)::int as visits, count(distinct install_id)::int as installs,
              (select string_agg(distinct k, ', ') from ev e2 cross join lateral jsonb_object_keys(coalesce(e2.props, '{}')) k
                where e2.name = ev.name) as props
         from ev group by 1 order by 2 desc limit 20`),
    installsBy("app_version"),
    installsBy("state"),
    installsBy("platform || ' ' || split_part(os_version, '.', 1)"),
    q(`select coalesce(source, 'Not matched') as label, count(*)::int as v from installs
        where ${WHERE_INSTALLS} and first_seen >= $2 and first_seen < $3 group by 1 order by 2 desc, 1 limit 12`, pi),
    q(`select max(last_seen) as at from installs where project_id = $1`, [site.id]),
    q(`select ts as at from events where project_id = $1 order by ts desc limit 1`, [site.id]),
    imp(`select ${IMPORTED_SUMS} ${IMPORTED_ROWS}`, "total", b.from, b.to),
    imp(`select ${IMPORTED_SUMS} ${IMPORTED_ROWS}`, "total", b.prevFrom, b.prevTo),
    seriesOf(IMPORTED_SERIES, b.from, b.to),
    seriesOf(IMPORTED_SERIES, b.prevFrom, b.prevTo),
    importedBy("source"),
    importedBy("page"),
    importedBy("entry"),
    importedBy("country"),
    importedBy("device"),
    importedBy("browser"),
    importedBy("os"),
    downloads(`select value as label, sum(downloads)::int as v from imported_days where project_id = $1 and dimension = 'release' group by 1 order by 2 desc, 1 limit 20`, [site.id]),
    downloads(`select coalesce(sum(downloads), 0)::int as total,
                      coalesce(sum(downloads) filter (where day >= ($2::timestamptz at time zone $4)::date and day <= (($3::timestamptz - interval '1 millisecond') at time zone $4)::date), 0)::int as period
                 from imported_days where project_id = $1 and dimension = 'releases'`, [site.id, b.from, b.to, tz]),
    downloads(`select to_char(date_trunc($5, day::timestamp), 'YYYY-MM-DD"T"HH24:MI') as t, sum(downloads)::int as v from imported_days
                where project_id = $1 and dimension = 'releases' and day >= ($2::timestamptz at time zone $4)::date
                  and day <= (($3::timestamptz - interval '1 millisecond') at time zone $4)::date group by 1`, [site.id, b.from, b.to, tz, b.unit]),
  ]);
  const byBucket = (rows: (Sums & { t: string })[]) => new Map(rows.map((r) => [r.t, r]));
  const mergeSeries = <T extends Totals & { t: string }>(own: T[], imported: (Sums & { t: string })[], released: { t: string; v: number }[] = []) => {
    const at = byBucket(imported);
    const gained = new Map(released.map((r) => [r.t, r.v]));
    return own.map((row) => ({ ...withImported(row, at.get(row.t)), ...(github ? { releases: gained.get(row.t) ?? 0 } : {}) }));
  };

  return {
    site: { key: site.key, name: site.name, domains: site.domains, timezone: tz },
    range: b,
    filters,
    totals: withImported(totals, importedTotals),
    previous: withImported(previous, importedPrevious),
    series: mergeSeries(series, importedSeries, releasesSeries),
    previousSeries: mergeSeries(previousSeries, importedPreviousSeries),
    sources: mergeRows(sources, importedSources),
    journeyBySource,
    pages: { top: mergeRows(topPages, importedPages), entry: mergeRows(entryPages, importedEntries), exit: exitPages },
    countries: mergeRows(countries, importedCountries),
    devices: { device: mergeRows(devices, importedDevices), browser: mergeRows(browsers, importedBrowsers), os: mergeRows(systems, importedSystems) },
    // What history the report holds: the imports, whether they're in it, and from which day Statiku counted itself.
    imported: history.length ? { included: withHistory, narrowed, ownFrom: own?.day ?? null, sources: history } : null,
    releases: github ? { total: releasesPeriod?.total ?? 0, period: releasesPeriod?.period ?? 0, byRelease: releasesAll, repo: importsDone.find((s) => s.kind === "github")?.label ?? null } : null,
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

// Visitors on the site right now, counted by one of their details, most first.
function countBy(present: Session[], pick: (s: Session) => string | null) {
  const groups = new Map<string, Set<string>>();
  for (const s of present) {
    const label = pick(s) ?? "Unknown";
    if (!groups.has(label)) groups.set(label, new Set());
    groups.get(label)!.add(s.visitor);
  }
  return [...groups].map(([label, visitors]) => ({ label, v: visitors.size })).sort((a, b) => b.v - a.v || a.label.localeCompare(b.label)).slice(0, 10);
}

// Right now: who is on the site, where they are and what they're reading (from memory, so it's current to the
// second), today's totals, page views minute by minute for the last half hour, and the latest events. No visitor
// hash leaves the server.
export async function live(pool: pg.Pool, site: Site, present: Session[], streets: Streets) {
  const tz = site.timezone;
  const q = async (sql: string, params: unknown[] = [site.id]) => (await pool.query(sql, params)).rows;
  const [[today], perMinute, recent] = await Promise.all([
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
  // Where each visitor is: a visitor who shared their exact location is at their point, in the city and country their
  // street is in (their device knows better than their IP address); anyone else is at the centre of the city their IP
  // address suggests.
  const streetOf = (s: Session) => (s.exact ? streets.at(s.exact.lat, s.exact.lon) : null);
  const countryOf = (s: Session) => streetOf(s)?.country ?? s.country;
  const placeOf = (s: Session) => {
    const street = streetOf(s);
    if (s.exact && street?.city) return { city: street.city, region: street.region, lat: s.exact.lat, lon: s.exact.lon };
    return s.place ?? null;
  };
  // Cities for the zoomed-in globe: each with a point and how many visitors are there now.
  const cities = new Map<string, { country: string | null; city: string; region: string | null; lat: number; lon: number; visitors: Set<string>; sharing: Set<string> }>();
  // Shared points, for the globe at street level, with their addresses once OpenStreetMap has answered.
  const exact = new Map<string, { lat: number; lon: number; acc: number | null; found: Street | null | undefined; city: string | null; country: string | null; visitors: Set<string> }>();
  for (const s of present) {
    const place = placeOf(s);
    if (place) {
      const key = `${countryOf(s)}|${place.city}`;
      if (!cities.has(key)) cities.set(key, { country: countryOf(s), ...place, visitors: new Set(), sharing: new Set() });
      cities.get(key)!.visitors.add(s.visitor);
      if (s.exact) cities.get(key)!.sharing.add(s.visitor);
    }
    if (s.exact) {
      const key = `${s.exact.lat},${s.exact.lon}`;
      const { lat, lon, acc } = s.exact, found = streets.at(lat, lon);
      if (!exact.has(key)) exact.set(key, { lat, lon, acc, found, city: found?.city ?? s.place?.city ?? null, country: countryOf(s), visitors: new Set() });
      const point = exact.get(key)!;
      if (acc != null && (point.acc == null || acc < point.acc)) point.acc = acc;
      point.visitors.add(s.visitor);
    }
  }
  return {
    visitors: new Set(present.map((s) => s.visitor)).size,
    countries: countBy(present, countryOf),
    cities: [...cities.values()].map(({ visitors, sharing, ...c }) => ({ ...c, v: visitors.size, exact: sharing.size })).sort((a, b) => b.v - a.v || a.city.localeCompare(b.city)),
    exact: [...exact.values()].map(({ visitors, found, ...p }) => ({ ...p, street: addressOf(found, p.acc), area: found?.area ?? null, v: visitors.size })),
    asksLocation: site.askLocation,
    pages: countBy(present, (s) => s.exitPath),
    sources: countBy(present, (s) => s.source),
    devices: countBy(present, (s) => s.device),
    today, perMinute, recent, at: new Date(),
  };
}

// Every site the person can see, with today's numbers, who's on it now and a fortnight of daily visitors.
export async function overview(pool: pg.Pool, userId: string, presence: Presence) {
  const { rows: sites } = await pool.query(
    `select p.id, p.key, p.name, p.domains, p.timezone, p.created_at, m.role, p.icon is not null as has_icon, p.icon_checked_at,
            (select ts from events e where e.project_id = p.id order by ts desc limit 1) as last_event_at
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
      role: s.role, icon: s.has_icon ? new Date(s.icon_checked_at).getTime() : s.icon_checked_at ? false : null,
      live: new Set(presence(s.id).map((v) => v.visitor)).size,
      visitorsToday: todayRow?.visitors ?? 0, pageviewsToday: todayRow?.pageviews ?? 0, spark,
    };
  });
}
