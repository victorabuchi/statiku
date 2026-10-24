// History from before Statiku. Daily numbers come in from Google Analytics (by signing in with Google), Plausible
// (with an API key), a file exported from any other tool (Fathom, Matomo, Umami, Simple Analytics, a spreadsheet…),
// and the download counts of a GitHub repository's releases. Each import is kept apart from what Statiku collects, one
// row per day and breakdown value (db/migrations/007_imports.sql); stats.ts adds them in for the days before Statiku's
// own first event. Two imports never count the same day: the one that came first keeps it.
import { inflateRawSync } from "node:zlib";
import type pg from "pg";
import { sourceName } from "../ingest/source.ts";
import type { Outbound } from "./check.ts";

export type Dimension = "total" | "source" | "page" | "entry" | "country" | "device" | "browser" | "os" | "release" | "releases";
const MEASURES = ["visitors", "visits", "pageviews", "bounces", "duration", "measured", "downloads"] as const;
type Measures = Partial<Record<(typeof MEASURES)[number], number>>;
export type Row = Measures & { day: string; dimension: Dimension; value?: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 3_000_000;
// GitHub's download counts are their own measure, never another tool's history.
export const DOWNLOAD_DIMENSIONS = ["release", "releases"];

const parse = (body: Buffer) => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
};

// A local date in a time zone, as YYYY-MM-DD.
export const dayIn = (tz: string, at: string | number | Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

// ---------- Values, as Statiku names them ----------

const COUNTRIES = (() => {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const map = new Map<string, string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = names.of(code);
      if (name && name !== code) map.set(name.toLowerCase(), code);
    }
  }
  for (const [name, code] of [
    ["united states of america", "US"], ["usa", "US"], ["uk", "GB"], ["great britain", "GB"], ["russia", "RU"], ["south korea", "KR"],
    ["korea, republic of", "KR"], ["czech republic", "CZ"], ["turkey", "TR"], ["vietnam", "VN"], ["iran", "IR"], ["taiwan", "TW"],
  ]) map.set(name, code);
  return map;
})();

const BROWSERS: [RegExp, string][] = [
  [/edge|^edg$/i, "Edge"], [/opera|^opr$/i, "Opera"], [/samsung/i, "Samsung Internet"], [/yandex/i, "Yandex"], [/vivaldi/i, "Vivaldi"],
  [/duckduckgo/i, "DuckDuckGo"], [/firefox|fxios/i, "Firefox"], [/chrome|chromium|crios|webview|brave/i, "Chrome"],
  [/safari|^ios$|webkit/i, "Safari"], [/facebook/i, "Facebook"], [/instagram/i, "Instagram"],
];
const SYSTEMS: [RegExp, string][] = [
  [/ipad/i, "iPadOS"], [/^ios|iphone|ipod/i, "iOS"], [/android/i, "Android"], [/windows/i, "Windows"], [/chrome ?os|cros/i, "ChromeOS"],
  [/mac|os x|darwin/i, "macOS"], [/linux|ubuntu|fedora|debian/i, "Linux"],
];
const DEVICES: Record<string, string> = { desktop: "Desktop", laptop: "Laptop", mobile: "Mobile", smartphone: "Mobile", phone: "Mobile", tablet: "Tablet" };

function pagePath(raw: string) {
  let path = raw;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {}
  }
  path = path.replace(/[?#].*$/, "");
  return (path.startsWith("/") ? path : `/${path}`).slice(0, 1024);
}

export function valueOf(dimension: Dimension, raw: string | null | undefined): string {
  const value = String(raw ?? "").replace(/\u0000/g, "").trim();
  if (dimension === "total" || dimension === "releases") return "";
  if (dimension === "source") return sourceName(value).slice(0, 100);
  if (!value || /^\(?(not set|unknown|none)\)?$/i.test(value)) return "Unknown";
  switch (dimension) {
    case "page":
    case "entry":
      return pagePath(value);
    case "country":
      return /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : COUNTRIES.get(value.toLowerCase()) ?? "Unknown";
    case "device":
      return DEVICES[value.toLowerCase()] ?? value.slice(0, 1).toUpperCase() + value.slice(1, 40).toLowerCase();
    case "browser":
      return BROWSERS.find(([re]) => re.test(value))?.[1] ?? value.slice(0, 60);
    case "os":
      return SYSTEMS.find(([re]) => re.test(value))?.[1] ?? value.slice(0, 60);
    default:
      return value.slice(0, 200);
  }
}

// ---------- Where the rows go ----------

// Collects an import's rows, adding up any that land on the same day and value, and writes them in batches.
export class Sink {
  pending = new Map<string, Row & { value: string }>();
  written = 0;
  pool: pg.Pool;
  importId: string;
  projectId: string;

  constructor(pool: pg.Pool, importId: string, projectId: string) {
    this.pool = pool;
    this.importId = importId;
    this.projectId = projectId;
  }

  async add(row: Row) {
    if (!DAY.test(row.day) || row.day < "1995-01-01" || row.day > "2100-01-01") return;
    const value = valueOf(row.dimension, row.value);
    const key = `${row.day}\u0001${row.dimension}\u0001${value}`;
    const had = this.pending.get(key);
    if (had) for (const m of MEASURES) had[m] = (had[m] ?? 0) + (Number(row[m]) || 0);
    else this.pending.set(key, { ...row, value });
    if (this.pending.size >= 5000) await this.flush();
  }

  async flush() {
    if (!this.pending.size) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    this.written += rows.length;
    if (this.written > MAX_ROWS) throw new Error(`That's more than ${MAX_ROWS.toLocaleString("en")} rows. Import a shorter period at a time.`);
    const column = (m: (typeof MEASURES)[number]) => rows.map((r) => Math.max(0, Math.round(Number(r[m]) || 0)));
    await this.pool.query(
      `insert into imported_days (import_id, project_id, day, dimension, value, visitors, visits, pageviews, bounces, duration, measured, downloads)
       select $1, $2, * from unnest($3::date[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[], $10::bigint[], $11::int[], $12::int[])
       on conflict (import_id, dimension, value, day) do update set
         visitors = imported_days.visitors + excluded.visitors, visits = imported_days.visits + excluded.visits,
         pageviews = imported_days.pageviews + excluded.pageviews, bounces = imported_days.bounces + excluded.bounces,
         duration = imported_days.duration + excluded.duration, measured = imported_days.measured + excluded.measured,
         downloads = imported_days.downloads + excluded.downloads`,
      [this.importId, this.projectId, rows.map((r) => r.day), rows.map((r) => r.dimension), rows.map((r) => r.value), ...MEASURES.map(column)],
    );
  }
}

export const IMPORT_COLUMNS = `id, kind, label, status, error, note, rows, first_day::text as "firstDay", last_day::text as "lastDay", created_at as "createdAt", finished_at as "finishedAt"`;

// Starts an import in the background and returns it as it begins. `run` fills the sink; what it returns is kept.
export async function startImport(
  pool: pg.Pool,
  o: { projectId: string; userId: string; kind: string; label: string; run: (sink: Sink) => Promise<{ config?: object; note?: string | null } | void> },
) {
  const { rows: [created] } = await pool.query(
    `insert into imports (project_id, kind, label, created_by) values ($1, $2, $3, $4) returning ${IMPORT_COLUMNS}`,
    [o.projectId, o.kind, o.label.slice(0, 200), o.userId],
  );
  const done = (async () => {
    const sink = new Sink(pool, created.id, o.projectId);
    try {
      const out = (await o.run(sink)) || {};
      await sink.flush();
      // Days an earlier import already has stay with it, so no day is counted twice.
      const { rows: [overlap] } = await pool.query(
        `with taken as materialized (
           select distinct o.day from imported_days o join imports i on i.id = o.import_id
            where o.project_id = $2 and o.import_id <> $1 and i.status = 'done' and o.dimension <> all($3)),
         gone as (delete from imported_days d using taken where d.import_id = $1 and d.day = taken.day and d.dimension <> all($3) returning d.day)
         select count(distinct day)::int as days from gone`,
        [created.id, o.projectId, DOWNLOAD_DIMENSIONS],
      );
      const { rows: [n] } = await pool.query(
        "select count(*)::int as rows, min(day)::text as first, max(day)::text as last from imported_days where import_id = $1",
        [created.id],
      );
      if (!n.rows) {
        throw new Error(overlap.days ? "Every day in it was already covered by an earlier import." : "There was nothing to import: no days with numbers were found.");
      }
      const note = [out.note, overlap.days ? `${overlap.days} ${overlap.days === 1 ? "day was" : "days were"} already covered by an earlier import and left out.` : null]
        .filter(Boolean).join(" ") || null;
      await pool.query(
        `update imports set status = 'done', rows = $2, first_day = $3, last_day = $4, config = coalesce($5, config), note = $6, finished_at = now() where id = $1`,
        [created.id, n.rows, n.first, n.last, out.config ? JSON.stringify(out.config) : null, note],
      );
    } catch (e) {
      await pool.query("delete from imported_days where import_id = $1", [created.id]).catch(() => {});
      await pool.query("update imports set status = 'failed', error = $2, finished_at = now() where id = $1", [created.id, failure(e)]).catch(() => {});
    }
  })();
  return { created, done };
}

function failure(e: unknown) {
  const code = (e as { code?: string }).code;
  if (code === "ENOTFOUND") return "That server couldn't be found. Check the address.";
  if (code === "EPRIVATE") return "That address isn't a public server.";
  if (code === "ETIMEDOUT") return "The other service took too long to answer. Try again.";
  if (code === "ETOOBIG") return "The other service sent more than can be imported at once.";
  return ((e as Error).message || "The import failed.").slice(0, 500);
}

// ---------- Google Analytics ----------

export type Google = { auth: string; token: string; data: string; admin: string; clientId?: string; clientSecret?: string };
export const GOOGLE: Google = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  data: "https://analyticsdata.googleapis.com",
  admin: "https://analyticsadmin.googleapis.com",
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
};

async function googleJson(request: Outbound, url: URL, token: string, body?: object) {
  const res = await request(url, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
  });
  const data = parse(res.body);
  if (res.status >= 400) throw new Error(`Google Analytics said: ${data?.error?.message ?? `error ${res.status}`}`);
  return data;
}

// The Google Analytics 4 properties the person can read.
export async function googleProperties(request: Outbound, google: Google, token: string) {
  const out: { id: string; name: string; account: string }[] = [];
  let page = "";
  do {
    const url = new URL("/v1beta/accountSummaries", google.admin);
    url.searchParams.set("pageSize", "200");
    if (page) url.searchParams.set("pageToken", page);
    const data = await googleJson(request, url, token);
    for (const a of data?.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) out.push({ id: String(p.property).replace(/^properties\//, ""), name: String(p.displayName ?? p.property), account: String(a.displayName ?? "") });
    }
    page = data?.nextPageToken ?? "";
  } while (page && out.length < 2000);
  return out;
}

// One report per breakdown, every day since GA4 began.
const GOOGLE_REPORTS: [Dimension, string | null, string[]][] = [
  ["total", null, ["totalUsers", "sessions", "screenPageViews", "bounceRate", "averageSessionDuration"]],
  ["source", "sessionSource", ["totalUsers", "sessions", "screenPageViews"]],
  ["page", "pagePath", ["totalUsers", "screenPageViews"]],
  ["entry", "landingPage", ["sessions"]],
  ["country", "countryId", ["totalUsers"]],
  ["device", "deviceCategory", ["totalUsers"]],
  ["browser", "browser", ["totalUsers"]],
  ["os", "operatingSystem", ["totalUsers"]],
];

export async function importGoogle(sink: Sink, request: Outbound, google: Google, token: () => Promise<string>, property: string) {
  if (!/^\d{1,20}$/.test(property)) throw new Error("That isn't a Google Analytics 4 property.");
  for (const [dimension, name, metrics] of GOOGLE_REPORTS) {
    for (let offset = 0; ;) {
      const data = await googleJson(request, new URL(`/v1beta/properties/${property}:runReport`, google.data), await token(), {
        dateRanges: [{ startDate: "2015-08-14", endDate: "today" }],
        dimensions: [{ name: "date" }, ...(name ? [{ name }] : [])],
        metrics: metrics.map((m) => ({ name: m })),
        limit: 100_000,
        offset,
      });
      const rows: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] = data?.rows ?? [];
      for (const r of rows) {
        const d = r.dimensionValues[0]?.value ?? "";
        const m = Object.fromEntries(metrics.map((k, i) => [k, Number(r.metricValues[i]?.value) || 0]));
        const sessions = m.sessions ?? 0;
        await sink.add({
          day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, dimension, value: name ? r.dimensionValues[1]?.value : "",
          visitors: m.totalUsers, visits: m.sessions, pageviews: m.screenPageViews,
          ...(dimension === "total" ? { bounces: (m.bounceRate ?? 0) * sessions, duration: (m.averageSessionDuration ?? 0) * sessions, measured: sessions } : {}),
        });
      }
      offset += rows.length;
      if (!rows.length || offset >= Number(data?.rowCount ?? 0)) break;
    }
  }
}

// ---------- Plausible ----------

const PLAUSIBLE_REPORTS: [Dimension, string | null, string[]][] = [
  ["total", null, ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"]],
  ["source", "visit:source", ["visitors", "visits", "pageviews"]],
  ["page", "event:page", ["visitors", "pageviews"]],
  ["entry", "visit:entry_page", ["visits"]],
  ["country", "visit:country", ["visitors"]],
  ["device", "visit:device", ["visitors"]],
  ["browser", "visit:browser", ["visitors"]],
  ["os", "visit:os", ["visitors"]],
];

// Plausible's Stats API (v2), on plausible.io or a server of one's own, every day since the site began.
export async function importPlausible(sink: Sink, request: Outbound, o: { host: URL; key: string; site: string }) {
  const url = new URL("/api/v2/query", o.host);
  for (const [dimension, name, metrics] of PLAUSIBLE_REPORTS) {
    for (let offset = 0; ; offset += 10_000) {
      const res = await request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ site_id: o.site, metrics, date_range: "all", dimensions: ["time:day", ...(name ? [name] : [])], pagination: { limit: 10_000, offset } }),
      });
      const data = parse(res.body);
      if (res.status === 401) throw new Error("Plausible didn't accept that API key. Create a Stats API key in your Plausible account settings.");
      if (res.status === 404 && !data) throw new Error("There's no Plausible at that address.");
      if (res.status >= 400) throw new Error(`Plausible said: ${data?.error ?? `error ${res.status}`}`);
      const results: { dimensions: string[]; metrics: number[] }[] = data?.results ?? [];
      for (const r of results) {
        const m = Object.fromEntries(metrics.map((k, i) => [k, Number(r.metrics[i]) || 0]));
        await sink.add({
          day: String(r.dimensions[0]).slice(0, 10), dimension, value: name ? String(r.dimensions[1] ?? "") : "",
          visitors: m.visitors, visits: m.visits, pageviews: m.pageviews,
          ...(dimension === "total" ? { bounces: (m.bounce_rate / 100) * m.visits, duration: m.visit_duration * m.visits, measured: m.visits } : {}),
        });
      }
      if (results.length < 10_000) break;
    }
  }
}

// ---------- GitHub releases ----------

export const repoOf = (input: unknown) => {
  const m = String(input ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]{1,100})\/([\w.-]{1,100}?)(?:\.git)?\/?$/i);
  return m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]) ? `${m[1]}/${m[2]}` : null;
};

export type Release = { tag: string; at: string; assets: { id: string; count: number }[] };

export async function githubReleases(request: Outbound, api: string, repo: string, token?: string | null): Promise<Release[]> {
  const out: Release[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await request(new URL(`/repos/${repo}/releases?per_page=100&page=${page}`, api), {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (res.status === 404) throw new Error(`GitHub has no ${token ? "" : "public "}repository ${repo}${token ? " that this token can read" : ""}.`);
    if (res.status === 401) throw new Error("GitHub didn't accept that token.");
    if (res.status === 403 || res.status === 429) throw new Error("GitHub's limit on requests was reached. Try again in an hour, or add a token.");
    if (res.status >= 400) throw new Error(`GitHub said: error ${res.status}`);
    const list = (parse(res.body) ?? []) as { draft?: boolean; tag_name?: string; name?: string; id: number; published_at?: string; created_at: string; assets?: { id: number; download_count: number }[] }[];
    for (const r of list) {
      if (r.draft) continue;
      out.push({ tag: String(r.tag_name || r.name || r.id).slice(0, 100), at: r.published_at ?? r.created_at, assets: (r.assets ?? []).map((a) => ({ id: String(a.id), count: Number(a.download_count) || 0 })) });
    }
    if (list.length < 100) break;
  }
  return out;
}

export const countsOf = (releases: Release[]) => Object.fromEntries(releases.flatMap((r) => r.assets.map((a) => [a.id, a.count])));

// The first import: every release's downloads so far, on the day it came out.
export async function importGithub(sink: Sink, releases: Release[], tz: string) {
  for (const r of releases) {
    const downloads = r.assets.reduce((n, a) => n + a.count, 0);
    if (!downloads) continue;
    const day = dayIn(tz, r.at);
    await sink.add({ day, dimension: "release", value: r.tag, downloads });
    await sink.add({ day, dimension: "releases", downloads });
  }
}

// Later refreshes: what each release gained since the last look, on today.
export async function addDownloadsSince(sink: Sink, releases: Release[], before: Record<string, number>, tz: string) {
  const day = dayIn(tz, Date.now());
  for (const r of releases) {
    const gained = r.assets.reduce((n, a) => n + Math.max(0, a.count - (before[a.id] ?? 0)), 0);
    if (!gained) continue;
    await sink.add({ day, dimension: "release", value: r.tag, downloads: gained });
    await sink.add({ day, dimension: "releases", downloads: gained });
  }
}

// ---------- Files ----------

// The CSV files in a ZIP (an export is often several). Only what a CSV export holds is unpacked, within limits.
export function unzip(data: Buffer): { name: string; data: Buffer }[] {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That ZIP file couldn't be read.");
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const files: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error("That ZIP file couldn't be read.");
    const method = data.readUInt16LE(at + 10), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (name.endsWith("/") || !/\.(csv|tsv|txt)$/i.test(name) || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    total += size;
    if (size === 0xffffffff || total > 300_000_000) throw new Error("That ZIP file is too large once unpacked. Import its files a few at a time.");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error(`${name} is packed in a way that can't be read. Unzip it and import the CSV.`);
    files.push({ name: name.split("/").pop()!, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }) });
  }
  return files;
}

export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  // The separator is whichever of comma, semicolon and tab the first real line has most of.
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) ?? "";
  const separator = [",", ";", "\t"].map((c) => [c, firstLine.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === separator) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const norm = (header: string) => header.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
// What each kind of column is called by the tools people export from.
const NAMES = {
  date: ["date", "day", "datetime", "timestamp", "time", "period", "x", "dateday", "createdat", "eventdate", "datum"],
  visitors: ["visitors", "uniquevisitors", "uniques", "users", "totalusers", "activeusers", "nbuniqvisitors", "people", "unique"],
  visits: ["visits", "sessions", "nbvisits", "entrances", "totalvisits"],
  pageviews: ["pageviews", "views", "screenpageviews", "nbpageviews", "pageviewcount", "hits"],
  bounces: ["bounces", "bouncecount"],
  bounceRate: ["bouncerate", "bounce"],
  durationTotal: ["sumvisitlength", "totaltime", "totalduration"],
  durationAverage: ["visitduration", "avgduration", "averagesessionduration", "avgtimeonsite", "averagevisitduration", "avgvisitduration", "averagetime", "timeonsite", "avgsessionduration"],
  source: ["source", "sessionsource", "firstusersource", "referrer", "referrers", "referrerhostname", "referrerdomain", "referringdomain", "sourcemedium", "sessionsourcemedium"],
  entry: ["entrypage", "landingpage", "landingpagequerystring", "entrypages"],
  page: ["page", "pages", "path", "pathname", "urlpath", "pagepath", "pagepathandscreenclass", "url", "pageurl"],
  country: ["country", "countrycode", "countryid", "countryname", "countries", "countryisocode"],
  device: ["device", "devicetype", "devicecategory", "devices"],
  browser: ["browser", "browsers", "browsername"],
  os: ["os", "operatingsystem", "operatingsystems", "osname"],
  visitor: ["sessionid", "visitorid", "visitor", "userid", "idvisitor", "uid"],
  visit: ["visitid", "idvisit"],
  eventType: ["eventtype", "type"],
};
const DIMENSION_COLUMNS = ["source", "entry", "page", "country", "device", "browser", "os"] as const;
const METRIC_COLUMNS = ["visitors", "visits", "pageviews", "bounces", "bounceRate", "durationTotal", "durationAverage"] as const;

// A number as exports write them: "1,234", "1 234", "45.3%", "45,3 %".
function number(raw: string): number | null {
  let s = raw.replace(/[\s %]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// A duration in seconds: 83, "83s", "1m 23s", "00:01:23".
function seconds(raw: string): number | null {
  const s = raw.trim();
  const clock = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const units = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(h|m|min|s|sec)\b/gi)];
  if (units.length) return units.reduce((n, [, v, u]) => n + Number(v.replace(",", ".")) * (/^h/i.test(u) ? 3600 : /^m/i.test(u) ? 60 : 1), 0);
  return number(s);
}
const rate = (raw: string) => {
  const n = number(raw);
  if (n === null) return null;
  return raw.includes("%") || n > 1 ? n / 100 : n;
};

// Dates as exports write them. Slashes are read month first unless the column shows days past 12 first.
function dateReader(values: string[], tz: string) {
  const slashes = values.map((v) => v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)).filter(Boolean) as RegExpMatchArray[];
  const dayFirst = slashes.some((m) => Number(m[1]) > 12) && !slashes.some((m) => Number(m[2]) > 12);
  const two = (n: number | string) => String(n).padStart(2, "0");
  return (raw: string): string | null => {
    const v = raw.trim();
    let m;
    // A moment with a time (one row per event): its day where the site is. Without a zone it's taken as UTC.
    if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/))) {
      const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}${m[8] ?? "Z"}`);
      return Number.isFinite(at) ? dayIn(tz, at) : null;
    }
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${two(m[2])}-${two(m[3])}`;
    if ((m = v.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if ((m = v.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/))) return `${m[3]}-${two(m[2])}-${two(m[1])}`;
    if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return dayFirst ? `${m[3]}-${two(m[2])}-${two(m[1])}` : `${m[3]}-${two(m[1])}-${two(m[2])}`;
    if (/[a-z]/i.test(v) && /\d{4}/.test(v)) {
      const at = new Date(v.replace(/^[a-z]+,\s*/i, ""));
      if (Number.isFinite(at.getTime())) return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
    }
    return null;
  };
}

// Every table in the files: daily numbers (a row per day, or per day and source, page, country…), or one row per page
// view (Umami's export) that gets counted up by day. Files that hold something Statiku doesn't keep are skipped, and
// the note says which.
export async function importFiles(sink: Sink, files: { name: string; data: Buffer }[], tz: string): Promise<{ note: string | null }> {
  const expanded = files.flatMap((f) => (/\.zip$/i.test(f.name) || f.data.readUInt32LE(0) === 0x04034b50 ? unzip(f.data) : [f]));
  if (!expanded.length) throw new Error("There were no CSV files in that.");
  const skipped: string[] = [];
  let used = 0;
  for (const file of expanded) {
    const rows = parseCsv(file.data.toString("utf8"));
    // Tables are separated by empty lines; lines starting with # are notes (Google Analytics writes those).
    const tables: string[][][] = [];
    let current: string[][] = [];
    for (const row of rows) {
      if (row[0]?.startsWith("#")) continue;
      if (row.every((c) => !c.trim())) {
        if (current.length) tables.push(current);
        current = [];
      } else current.push(row);
    }
    if (current.length) tables.push(current);
    let found = false;
    for (const table of tables) {
      const outcome = await importTable(sink, file.name, table, tz);
      if (outcome === true) found = true;
      else if (outcome) skipped.push(outcome);
    }
    if (found) used++;
  }
  if (!used) throw new Error(skipped.length ? `Nothing could be imported. ${skipped.join(" ")}` : "No table with a date column was found. Export daily numbers, with a date on each row.");
  return { note: skipped.length ? skipped.join(" ") : null };
}

async function importTable(sink: Sink, file: string, table: string[][], tz: string): Promise<true | string | null> {
  const header = table[0].map(norm);
  const data = table.slice(1);
  const find = (names: string[]) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  const date = find(NAMES.date);
  if (date < 0 || !data.length) return null;
  const columns = Object.fromEntries([...METRIC_COLUMNS, ...DIMENSION_COLUMNS, "visitor", "visit", "eventType"].map((k) => [k, find(NAMES[k as keyof typeof NAMES])])) as Record<string, number>;
  const dimension = DIMENSION_COLUMNS.find((d) => columns[d] >= 0) ?? null;
  const metrics = METRIC_COLUMNS.filter((m) => columns[m] >= 0);
  const day = dateReader(data.slice(0, 500).map((r) => r[date] ?? ""), tz);
  const known = new Set([date, ...Object.values(columns).filter((i) => i >= 0)]);
  // Other columns of words (an exit page, an event name): with no breakdown Statiku knows, such a table would be
  // counted as the site's totals, so it's left out.
  const wordy = header.map((_, i) => i).filter((i) => !known.has(i) && data.slice(0, 50).some((r) => r[i]?.trim() && number(r[i]) === null && seconds(r[i]) === null));

  if (!metrics.length) {
    // One row per page view, with a time: count them up.
    if (!data.slice(0, 20).some((r) => /\d{1,2}:\d{2}/.test(r[date] ?? ""))) return `${file} has no visitors, visits or page views column.`;
    await importEvents(sink, data, day, columns, date);
    return true;
  }
  if (!dimension && wordy.length) return `${file} was skipped: it's broken down by ${table[0][wordy[0]]}, which Statiku doesn't keep from other tools.`;
  // Plausible's own export writes the total time of the day's visits; everyone else, the average.
  const totalTime = /^imported_/i.test(file);
  const at = (r: string[], k: string) => (columns[k] >= 0 ? r[columns[k]] ?? "" : "");
  for (const r of data) {
    const d = day(r[date] ?? "");
    if (!d) continue;
    const visits = number(at(r, "visits")) ?? 0;
    const bounces = columns.bounces >= 0 ? number(at(r, "bounces")) : columns.bounceRate >= 0 && visits ? (rate(at(r, "bounceRate")) ?? 0) * visits : null;
    const average = columns.durationAverage >= 0 ? seconds(at(r, "durationAverage")) : null;
    const duration = columns.durationTotal >= 0 ? seconds(at(r, "durationTotal")) : average !== null ? (totalTime ? average : average * visits) : null;
    await sink.add({
      day: d, dimension: dimension ?? "total", value: dimension ? r[columns[dimension]] : "",
      visitors: number(at(r, "visitors")) ?? 0, visits, pageviews: number(at(r, "pageviews")) ?? 0,
      ...(bounces !== null || duration !== null ? { bounces: bounces ?? 0, duration: duration ?? 0, measured: visits } : {}),
    });
  }
  return true;
}

// Raw events: each row a page view (or another event, when the table says which), counted by day, visitor and visit.
async function importEvents(sink: Sink, data: string[][], day: (raw: string) => string | null, columns: Record<string, number>, date: number) {
  type Tally = { visitors: Set<string>; visits: Set<string>; pageviews: number };
  const tallies = new Map<string, Tally>();
  const tally = (key: string) => tallies.get(key) ?? tallies.set(key, { visitors: new Set(), visits: new Set(), pageviews: 0 }).get(key)!;
  const firstPage = new Map<string, { at: string; day: string; page: string }>();
  for (const r of data) {
    const d = day(r[date] ?? "");
    if (!d) continue;
    const type = columns.eventType >= 0 ? (r[columns.eventType] ?? "").trim().toLowerCase() : "";
    if (type && !["1", "pageview", "page_view", "page"].includes(type)) continue;
    const visitor = columns.visitor >= 0 ? r[columns.visitor] ?? "" : "";
    const visit = columns.visit >= 0 ? r[columns.visit] ?? "" : visitor;
    const add = (key: string) => {
      const t = tally(key);
      t.pageviews++;
      if (visitor) t.visitors.add(visitor);
      if (visit) t.visits.add(visit);
    };
    add(`${d}\u0001total\u0001`);
    for (const dim of DIMENSION_COLUMNS) if (dim !== "entry" && columns[dim] >= 0) add(`${d}\u0001${dim}\u0001${r[columns[dim]] ?? ""}`);
    const page = columns.page >= 0 ? r[columns.page] ?? "" : "";
    const seen = firstPage.get(visit);
    if (visit && page && (!seen || (r[date] ?? "") < seen.at)) firstPage.set(visit, { at: r[date] ?? "", day: d, page });
  }
  for (const [key, t] of tallies) {
    const [d, dimension, value] = key.split("\u0001");
    await sink.add({ day: d, dimension: dimension as Dimension, value, visitors: t.visitors.size, visits: t.visits.size, pageviews: t.pageviews });
  }
  for (const { day: d, page } of firstPage.values()) await sink.add({ day: d, dimension: "entry", value: page, visits: 1 });
}
