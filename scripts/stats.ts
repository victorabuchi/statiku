// A plain-text report for one project, until the dashboard exists.
//   npm run stats -- <key> [days, default 7]
import pg from "pg";

function table(title: string, rows: Record<string, unknown>[]): string {
  if (!rows.length) return `${title}\n  (none)\n`;
  const cols = Object.keys(rows[0]);
  const cells = [cols, ...rows.map((r) => cols.map((c) => String(r[c] ?? "")))];
  const widths = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const line = (row: string[]) => "  " + row.map((v, i) => (i ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ");
  return `${title}\n${cells.map(line).join("\n")}\n`;
}

export async function report(pool: pg.Pool, key: string, days = 7): Promise<string> {
  const project = (await pool.query("select id, name from projects where key = $1", [key])).rows[0];
  if (!project) return `No project ${key}`;
  const since = new Date(Date.now() - days * 86400_000);
  const q = async (sql: string) => (await pool.query(sql, [project.id, since])).rows;
  const [totals] = await q(`
    select (select count(*) from (select distinct visitor, (ts at time zone 'utc')::date from events
              where project_id = $1 and ts >= $2 and visitor is not null) v) as visitors,
           (select count(*) from sessions where project_id = $1 and started_at >= $2) as visits,
           (select count(*) from events where project_id = $1 and ts >= $2 and name = 'pageview') as pageviews,
           (select round(100.0 * count(*) filter (where events = 1) / nullif(count(*), 0)) || '%'
              from sessions where project_id = $1 and started_at >= $2) as bounce_rate,
           (select coalesce(round(extract(epoch from avg(last_seen - started_at))) || ' s', '-')
              from sessions where project_id = $1 and started_at >= $2) as visit_duration`);
  const by = (column: string) =>
    q(`select ${column} as "${column}", count(*) as visits from sessions
        where project_id = $1 and started_at >= $2 group by 1 order by 2 desc, 1 limit 10`);
  return [
    `${project.name} (${key}), the last ${days} days\n`,
    table("Totals", [totals]),
    table("Pages", await q(`select path, count(*) as pageviews, count(distinct visitor) as visitors from events
      where project_id = $1 and ts >= $2 and name = 'pageview' group by 1 order by 2 desc, 1 limit 10`)),
    table("Sources", await by("source")),
    table("Campaigns", await q(`select utm_campaign as campaign, source, count(*) as visits from sessions
      where project_id = $1 and started_at >= $2 and utm_campaign is not null group by 1, 2 order by 3 desc limit 10`)),
    table("Countries", await by("country")),
    table("Devices", await by("device")),
    table("Browsers", await by("browser")),
    table("Operating systems", await by("os")),
    table("Events", await q(`select name, count(*) as events, count(distinct session_id) as visits from events
      where project_id = $1 and ts >= $2 and name <> 'pageview' group by 1 order by 2 desc limit 20`)),
    table("Funnel by source (visits)", await q(`
      with steps as (
        select session_id, bool_or(name = 'download') as download, bool_or(name = 'checkout') as checkout
          from events where project_id = $1 and ts >= $2 group by 1)
      select s.source, count(*) as visits, count(*) filter (where steps.download) as downloaded,
             count(*) filter (where steps.checkout) as checkout
        from sessions s left join steps on steps.session_id = s.id
       where s.project_id = $1 and s.started_at >= $2 group by 1 order by 2 desc, 1 limit 10`)),
  ].join("\n");
}

if (import.meta.main) {
  const [key, days] = process.argv.slice(2);
  if (!key) {
    console.log("Usage: npm run stats -- <project key> [days]");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  console.log(await report(pool, key, Number(days ?? 7)));
  await pool.end();
}
