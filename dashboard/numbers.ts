// A site's trackers (ingest/numbers.ts takes their values in): each one's value for a period and the one before, its
// latest value, and a line of it over the period (for a tracker of words, its last few words), for the Trackers page
// and the TV view. An "add" tracker's value is its total for the period; any other's is its last value in it. Values
// can also come in a file (CSV): a row per value (time, name, value) or a column per tracker (time, then one each).
import type pg from "pg";
import { hashKey, nameOf, newNumbersKey, timeOf, valueOf, type Kind } from "../ingest/numbers.ts";
import { parseCsv } from "./imports.ts";
import { bounds, type Site } from "./stats.ts";

export async function numbersReport(pool: pg.Pool, site: Site, rangeId: string, custom: { from?: string | null; to?: string | null } = {}) {
  const b = await bounds(pool, site.id, site.timezone, rangeId, custom);
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  // A period's value per number: the total of an "add" number, the last value of any other.
  const PERIOD = `
    select m.name, m.kind,
           case when m.kind = 'add' then sum(p.value) when m.kind = 'set' then (array_agg(p.value order by p.ts desc))[1] end as value,
           case when m.kind = 'text' then (array_agg(p.text_value order by p.ts desc) filter (where p.ts is not null))[1] end as text, count(p.ts)::int as points
      from metrics m left join metric_points p on p.project_id = m.project_id and p.name = m.name and p.ts >= $2 and p.ts < $3
     where m.project_id = $1 group by 1, 2`;
  const [now, before, latest, series, words] = await Promise.all([
    q(PERIOD, [site.id, b.from, b.to]),
    q(PERIOD, [site.id, b.prevFrom, b.prevTo]),
    q(`select distinct on (name) name, coalesce(value::text, text_value) as value, ts from metric_points where project_id = $1 order by name, ts desc`, [site.id]),
    q(`with buckets as (
         select generate_series(date_trunc($5, $2::timestamptz at time zone $4), date_trunc($5, ($3::timestamptz - interval '1 millisecond') at time zone $4), ('1 ' || $5)::interval) as t),
       agg as (
         select name, date_trunc($5, ts at time zone $4) as t, sum(value) as total, (array_agg(value order by ts desc))[1] as last
           from metric_points where project_id = $1 and ts >= $2 and ts < $3 group by 1, 2)
       select m.name, to_char(buckets.t, 'YYYY-MM-DD"T"HH24:MI') as t, case when m.kind = 'add' then coalesce(agg.total, 0) else agg.last end as v
         from metrics m cross join buckets left join agg on agg.name = m.name and agg.t = buckets.t
        where m.project_id = $1 order by m.name, buckets.t`, [site.id, b.from, b.to, site.timezone, b.unit]),
    // A tracker of words: its last five in the period, latest first.
    q(`select name, ts, text_value as text from (
         select name, ts, text_value, row_number() over (partition by name order by ts desc) as n from metric_points
          where project_id = $1 and ts >= $2 and ts < $3 and text_value is not null) x where n <= 5 order by name, ts desc`, [site.id, b.from, b.to]),
  ]);
  const recent = new Map<string, { ts: Date; text: string }[]>();
  for (const w of words) recent.set(w.name, [...(recent.get(w.name) ?? []), { ts: w.ts, text: w.text }]);
  const prev = new Map(before.map((r) => [r.name, r.value]));
  const last = new Map(latest.map((r) => [r.name, { value: r.value === null || Number.isNaN(Number(r.value)) ? r.value : Number(r.value), ts: r.ts }]));
  const lines = new Map<string, { t: string; v: number | null }[]>();
  for (const r of series) {
    const line = lines.get(r.name);
    if (line) line.push({ t: r.t, v: r.v });
    else lines.set(r.name, [{ t: r.t, v: r.v }]);
  }
  const numbers = now
    .map((r) => ({
      name: r.name as string, kind: r.kind as Kind, value: (r.kind === "text" ? r.text : r.value) as number | string | null,
      previous: (r.kind === "text" ? null : prev.get(r.name) ?? null) as number | null, points: r.points as number, last: last.get(r.name) ?? null,
      series: r.kind === "text" ? [] : lines.get(r.name) ?? [], recent: recent.get(r.name) ?? [],
    }))
    // Numbers that moved most recently first.
    .sort((a, z) => (z.last?.ts?.getTime() ?? 0) - (a.last?.ts?.getTime() ?? 0) || a.name.localeCompare(z.name));
  const { rows: [key] } = await pool.query("select numbers_key_hash is not null as has from projects where id = $1", [site.id]);
  return { range: b, numbers, hasKey: key.has as boolean };
}

// A new key for sending numbers; the old one stops working. Only its hash is kept, so it's shown this once.
export async function renewNumbersKey(pool: pg.Pool, projectId: string) {
  const key = newNumbersKey();
  await pool.query("update projects set numbers_key_hash = $2 where id = $1", [projectId, hashKey(key)]);
  return key;
}

// Numbers from CSV files: "time, name, value" rows, or a time column and a column per number. Times without a zone
// are in the site's.
type FilePoint = { name: string; ts: Date; value: number | null; text: string | null; labels?: Record<string, string> | null };
export function parseNumbersFile(text: string, now = new Date()): { points: FilePoint[]; kinds: Map<string, Kind> } | string {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()) && !r[0]?.startsWith("#"));
  if (rows.length < 2) return "The file needs a header row and at least one row of numbers.";
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const timeCol = head.findIndex((h) => /^(time|timestamp|date|day|datetime|ts|at|when)$/.test(h));
  const nameCol = head.findIndex((h) => /^(name|number|metric|series)$/.test(h));
  const valueCol = head.findIndex((h) => /^(value|amount|count|score|reading)$/.test(h));
  const opCol = head.findIndex((h) => /^(op|kind|type)$/.test(h));
  const points: FilePoint[] = [];
  const kinds = new Map<string, Kind>();
  // A cell's value: a number, or a word (any other text).
  const cell = (c: string | undefined) => valueOf(String(c ?? ""));
  const when = (c: string | undefined, line: number) => {
    const raw = String(c ?? "").trim();
    // A plain date is that day's start; a time without a zone is read as UTC (the server's), close enough for a chart.
    const at = timeOf(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw || null, now);
    if (!raw || !at) throw new Error(`Line ${line} has a time that isn't one: "${raw}". Use 2026-11-05 or 2026-11-05T14:30.`);
    return at;
  };
  try {
    if (nameCol >= 0 && valueCol >= 0) {
      if (timeCol < 0) return 'Add a "time" column, with each value\'s date or time.';
      // Any other column is a label of each value (plan, country, room).
      const labelCols = head.map((h, i) => ({ i, key: nameOf(rows[0][i]).slice(0, 40) })).filter((c) => ![timeCol, nameCol, valueCol, opCol].includes(c.i) && c.key).slice(0, 10);
      for (const [i, r] of rows.slice(1).entries()) {
        const name = nameOf(r[nameCol]), value = cell(r[valueCol]);
        if (!name || value === null) continue;
        const labels = Object.fromEntries(labelCols.map((c) => [c.key, nameOf(r[c.i]).slice(0, 100)]).filter(([, v]) => v));
        points.push({ name, ts: when(r[timeCol], i + 2), ...value, labels: Object.keys(labels).length ? labels : null });
        const op = String(r[opCol] ?? "").trim().toLowerCase();
        if (!kinds.has(name)) kinds.set(name, value.text !== null ? "text" : op === "add" ? "add" : "set");
      }
    } else {
      if (timeCol < 0) return 'The first row names the columns: "time", then a column for each number (or "time, name, value").';
      const columns = head.map((h, i) => ({ i, name: nameOf(rows[0][i]) })).filter((c) => c.i !== timeCol && c.name);
      if (!columns.length) return "There's no column of numbers next to the time.";
      for (const [i, r] of rows.slice(1).entries()) {
        let ts: Date | null = null;
        for (const c of columns) {
          const value = cell(r[c.i]);
          if (value === null) continue;
          ts ??= when(r[timeCol], i + 2);
          points.push({ name: c.name, ts, ...value });
          if (!kinds.has(c.name)) kinds.set(c.name, value.text !== null ? "text" : "set");
        }
      }
    }
  } catch (e) {
    return (e as Error).message;
  }
  if (!points.length) return "There are no values in the file.";
  if (points.length > 500_000) return "That's more than 500,000 values. Split the file into a few.";
  if (kinds.size > 500) return "That's more than 500 different trackers. A site can have up to 500.";
  // A tracker of words keeps its numbers as words.
  for (const p of points) if (kinds.get(p.name) === "text" && p.text === null) [p.text, p.value] = [String(p.value), null];
  return { points: points.filter((p) => kinds.get(p.name) === "text" || p.value !== null), kinds };
}

export async function saveNumbers(pool: pg.Pool, projectId: string, file: NonNullable<Exclude<ReturnType<typeof parseNumbersFile>, string>>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "insert into metrics (project_id, name, kind) select $1, * from unnest($2::text[], $3::text[]) on conflict do nothing",
      [projectId, [...file.kinds.keys()], [...file.kinds.values()]],
    );
    for (let i = 0; i < file.points.length; i += 5000) {
      const part = file.points.slice(i, i + 5000);
      await client.query(
        "insert into metric_points (project_id, name, ts, value, text_value, props) select $1, * from unnest($2::text[], $3::timestamptz[], $4::float8[], $5::text[], $6::jsonb[])",
        [projectId, part.map((p) => p.name), part.map((p) => p.ts), part.map((p) => p.value), part.map((p) => p.text), part.map((p) => (p.labels ? JSON.stringify(p.labels) : null))],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { saved: file.points.length, names: [...file.kinds.keys()] };
}

export async function deleteNumber(pool: pg.Pool, projectId: string, name: string) {
  await pool.query("delete from metric_points where project_id = $1 and name = $2", [projectId, name]);
  const { rowCount } = await pool.query("delete from metrics where project_id = $1 and name = $2", [projectId, name]);
  return (rowCount ?? 0) > 0;
}


// One tracker's analytics for a period: its values bucketed by the hour, day, week or month (a total, an average, the
// lowest, the highest, the latest or a count, as asked), the same for the period before, a summary, the labels its
// values carry, a split by one of them, and its latest values. For a tracker of words: how often each word came and
// how long each was the latest, and its last changes.
export const MEASURES = { sum: "sum(value)", avg: "avg(value)", min: "min(value)", max: "max(value)", last: "(array_agg(value order by ts desc))[1]", count: "count(*)" } as const;
export type Measure = keyof typeof MEASURES;
export async function trackerReport(pool: pg.Pool, site: Site, name: string, rangeId: string, o: { from?: string | null; to?: string | null; by?: string | null; measure?: string | null; split?: string | null } = {}) {
  const { rows: [tracker] } = await pool.query("select name, kind, created_at from metrics where project_id = $1 and name = $2", [site.id, name]);
  if (!tracker) return null;
  const b = await bounds(pool, site.id, site.timezone, rangeId, o);
  const UNITS_OK = ["hour", "day", "week", "month"];
  if (o.by && UNITS_OK.includes(o.by) && (b.to.getTime() - b.from.getTime()) / ({ hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[o.by]!) <= 1500) b.unit = o.by as typeof b.unit;
  const words = tracker.kind === "text";
  const measure: Measure = o.measure && o.measure in MEASURES ? (o.measure as Measure) : words ? "count" : tracker.kind === "add" ? "sum" : "last";
  const agg = words ? "count(*)" : MEASURES[measure];
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  const series = (from: Date, to: Date) => q(`
    with buckets as (
      select generate_series(date_trunc($5, $2::timestamptz at time zone $4), date_trunc($5, ($3::timestamptz - interval '1 millisecond') at time zone $4), ('1 ' || $5)::interval) as t),
    agg as (
      select date_trunc($5, ts at time zone $4) as t, ${agg} as v from metric_points
       where project_id = $1 and name = $6 and ts >= $2 and ts < $3 group by 1)
    select to_char(buckets.t, 'YYYY-MM-DD"T"HH24:MI') as t, agg.v::float8 as v from buckets left join agg using (t) order by buckets.t`, [site.id, from, to, site.timezone, b.unit, name]);
  const p = [site.id, b.from, b.to, name];
  const SUMMARY = `select count(*)::int as count, sum(value)::float8 as sum, avg(value)::float8 as avg, min(value)::float8 as min, max(value)::float8 as max,
                          (array_agg(coalesce(value::text, text_value) order by ts desc))[1] as last, (array_agg(coalesce(value::text, text_value) order by ts))[1] as first,
                          count(distinct text_value)::int as distinct
                     from metric_points where project_id = $1 and name = $4 and ts >= $2 and ts < $3`;
  const splitKey = o.split ? nameOf(o.split).slice(0, 40) : null;
  const [now, before, [summary], [previous], labels, split, values, wordShares] = await Promise.all([
    series(b.from, b.to),
    rangeId === "all" ? Promise.resolve([]) : series(b.prevFrom, b.prevTo),
    q(SUMMARY, p),
    rangeId === "all" ? Promise.resolve([{}]) : q(SUMMARY, [site.id, b.prevFrom, b.prevTo, name]),
    q(`select k as key, count(*)::int as n from metric_points cross join lateral jsonb_object_keys(props) k
        where project_id = $1 and name = $4 and ts >= $2 and ts < $3 and props is not null group by 1 order by 2 desc, 1 limit 12`, p),
    splitKey
      ? q(`select coalesce(props ->> $5, 'No ${"label"}') as label, ${words ? "count(*)" : MEASURES[measure === "last" ? (tracker.kind === "add" ? "sum" : "avg") : measure]}::float8 as v, count(*)::int as n
             from metric_points where project_id = $1 and name = $4 and ts >= $2 and ts < $3 group by 1 order by 2 desc nulls last, 1 limit 24`, [...p, splitKey])
      : Promise.resolve(null),
    q(`select ts, value, text_value as text, props as labels from metric_points where project_id = $1 and name = $4 and ts >= $2 and ts < $3 order by ts desc limit 200`, p),
    // How often each word came, and how long each was the latest (until the next value, or now).
    words
      ? q(`with w as (select text_value as label, ts, lead(ts) over (order by ts) as next from metric_points where project_id = $1 and name = $4 and ts >= $2 and ts < $3)
           select label, count(*)::int as count, extract(epoch from sum(coalesce(next, least($3::timestamptz, now())) - ts))::float8 as seconds
             from w group by 1 order by 2 desc, 1 limit 24`, p)
      : Promise.resolve(null),
  ]);
  return {
    tracker: { name: tracker.name as string, kind: tracker.kind as Kind, since: tracker.created_at as Date },
    range: b, measure, split: splitKey,
    series: now, previousSeries: before, summary, previous, labels, splitRows: split, values,
    words: wordShares,
  };
}
