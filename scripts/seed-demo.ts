// 30 days of made-up visits to a Notchlight-like site and installs of its app, sent through the real collection code
// (sessions, sources, countries, devices, download marks, installs), so the dashboard has something to show locally.
// Reruns replace the demo project's data.
//   npm run seed
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { collectApp } from "../ingest/app.ts";
import { collect, type Deps } from "../ingest/collect.ts";
import { Geo } from "../ingest/geo.ts";
import { Installs } from "../ingest/installs.ts";
import { Projects } from "../ingest/projects.ts";
import { Salts } from "../ingest/salts.ts";
import { Sessions } from "../ingest/sessions.ts";
import { Writer } from "../ingest/writer.ts";
import { createProject } from "./project.ts";

const NAME = "Notchlight (sample traffic)";
const SITE = "https://notchlight.com";
const DAYS = 30;

let seed = 7;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: [T, number][]): T => {
  let r = rand() * items.reduce((a, [, w]) => a + w, 0);
  for (const [item, w] of items) if ((r -= w) <= 0) return item;
  return items[0][0];
};

// Where visitors arrive from: the page URL's tags and the referrer, and how likely they are to download and buy.
type Arrival = { query: string; referrer: string | null; download: number; checkout: number };
const ARRIVALS: [Arrival, number][] = [
  [{ query: "", referrer: "https://www.google.com/", download: 0.3, checkout: 0.05 }, 24],
  [{ query: "?utm_source=macnative&utm_medium=listing", referrer: "https://macnative.io/", download: 0.38, checkout: 0.04 }, 15],
  [{ query: "", referrer: null, download: 0.28, checkout: 0.06 }, 17],
  [{ query: "", referrer: "https://www.reddit.com/r/macapps/", download: 0.24, checkout: 0.03 }, 10],
  [{ query: "", referrer: "https://news.ycombinator.com/item?id=45678901", download: 0.22, checkout: 0.025 }, 7],
  [{ query: "", referrer: "https://t.co/xK2", download: 0.18, checkout: 0.02 }, 6],
  [{ query: "?ref=producthunt", referrer: "https://www.producthunt.com/", download: 0.26, checkout: 0.04 }, 5],
  [{ query: "", referrer: "https://github.com/victorabuchi/notchlight", download: 0.34, checkout: 0.02 }, 6],
  [{ query: "", referrer: "https://duckduckgo.com/", download: 0.3, checkout: 0.05 }, 4],
  [{ query: "?utm_source=newsletter&utm_campaign=october", referrer: null, download: 0.35, checkout: 0.07 }, 3],
];
const HACKER_NEWS = ARRIVALS[4][0];

const DEVICES: [{ ua: string; width: number; mac: boolean }, number][] = [
  [{ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15", width: 1512, mac: true }, 32],
  [{ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", width: 1728, mac: true }, 26],
  [{ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:144.0) Gecko/20100101 Firefox/144.0", width: 1440, mac: true }, 7],
  [{ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", width: 1280, mac: true }, 2],
  [{ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1", width: 390, mac: false }, 13],
  [{ ua: "Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1", width: 820, mac: false }, 2],
  [{ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", width: 1920, mac: false }, 5],
  [{ ua: "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0", width: 1366, mac: false }, 2],
  [{ ua: "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", width: 412, mac: false }, 2],
];

const COUNTRIES: [string, number][] = [
  ["US", 31], ["DE", 11], ["GB", 8], ["FI", 6], ["NL", 5], ["CA", 5], ["FR", 4], ["SE", 4], ["JP", 3], ["AU", 3], ["IN", 3], ["CH", 2], ["ES", 2], ["PL", 2], ["BR", 2],
];

const geo = new Geo(new URL("../data/country.mmdb", import.meta.url));
if (!geo.reader) throw new Error("Run npm run geo first: the demo needs the country database.");
// Real addresses from each country, found by looking up random ones. They're only hashed, like any visitor's.
const pools = new Map<string, string[]>(COUNTRIES.map(([c]) => [c, []]));
for (let i = 0; i < 400_000 && [...pools.values()].some((p) => p.length < 300); i++) {
  const b = randomBytes(4);
  if (b[0] === 0 || b[0] === 10 || b[0] === 127 || b[0] >= 224) continue;
  const ip = [...b].join(".");
  const pool = pools.get(geo.country(ip) ?? "");
  if (pool && pool.length < 300) pool.push(ip);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query("select ensure_month_partitions('events', 2, 2), ensure_month_partitions('sessions', 2, 2)");
let project = (await pool.query("select id, key from projects where name = $1", [NAME])).rows[0];
project ??= await createProject(pool, NAME, ["notchlight.com"], "Europe/Helsinki");
for (const table of ["events", "sessions", "usage_daily", "installs", "download_marks"]) await pool.query(`delete from ${table} where project_id = $1`, [project.id]);

const sessions = new Sessions(pool);
const writer = new Writer(pool, sessions);
const salts = new Salts(pool);
const deps: Deps = { projects: new Projects(pool), salts, sessions, installs: new Installs(pool, salts), writer, geo };

let sent = 0;
const send = async (at: Date, name: string, path: string, arrival: Arrival, device: { ua: string; width: number }, ip: string, referrer: string | null, props?: object) => {
  const body = JSON.stringify({ k: project.key, n: name, u: SITE + path + (referrer === arrival.referrer ? arrival.query : ""), r: referrer, w: device.width, p: props });
  await collect(deps, body, device.ua, ip, at);
  sent++;
};

// The app: an install a few minutes after most downloads, from the same network, and some with no visit before them
// (Homebrew, or a link passed on). 1.5 came out four days ago.
const now = Date.now();
const RELEASE = now - 4 * 86400_000;
const SYSTEMS: [string, number][] = [["26.1", 45], ["26.0", 14], ["15.7", 30], ["15.6", 8], ["15.5", 3]];
type Install = { id: string; at: number; ip: string; version: string; os: string; buyRate: number };
const installs: Install[] = [];
let batches = 0;
const app = async (install: Install, at: number, state: string, events: { name: string; props?: object }[]) => {
  const build = install.version === "1.4" ? "5" : "6";
  const body = { project: project.key, install: install.id, platform: "macOS", osVersion: install.os, appVersion: install.version, build, state,
    events: events.map((e) => ({ ...e, at: new Date(at).toISOString() })) };
  await collectApp(deps, JSON.stringify(body), install.ip, new Date(at));
  batches++;
};
const newInstall = async (at: number, ip: string, buyRate: number) => {
  const install = { id: randomUUID(), at, ip, version: at < RELEASE ? "1.4" : "1.5", os: pick(SYSTEMS), buyRate };
  installs.push(install);
  await app(install, at, "trial", [{ name: "install" }, { name: "active" }, { name: "state", props: { to: "trial" } }]);
};

for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
  const dayStart = new Date(now - daysAgo * 86400_000);
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekend = [0, 6].includes(dayStart.getUTCDay());
  const launch = daysAgo === 12 ? 620 : daysAgo === 11 ? 210 : daysAgo === 10 ? 60 : 0;
  const ordinary = Math.round((48 + (DAYS - daysAgo) * 1.6) * (weekend ? 0.75 : 1) * (0.85 + rand() * 0.3));
  const visits: { at: number; arrival: Arrival }[] = [];
  for (let i = 0; i < ordinary + launch; i++) {
    // Afternoon and evening in Europe and the US get most visits; Hacker News launch visits bunch up early.
    const hour = i >= ordinary ? 13 + rand() * 6 : pick([[6, 1], [9, 2], [12, 3], [15, 4], [18, 4], [21, 3], [1, 1]]) + rand() * 3;
    visits.push({ at: dayStart.getTime() + hour * 3600_000, arrival: i >= ordinary ? HACKER_NEWS : pick(ARRIVALS) });
  }
  const downloads: { at: number; ip: string; arrival: Arrival }[] = [];
  for (const { at, arrival } of visits.sort((a, b) => a.at - b.at)) {
    if (at > now) continue;
    const device = pick(DEVICES);
    const ip = pick(pools.get(pick(COUNTRIES))!.map((x): [string, number] => [x, 1]));
    let t = at;
    const step = () => new Date((t += 15_000 + rand() * 120_000));
    const entry = pick([["/", 82], ["/download/", 12], ["/privacy/", 3], ["/terms/", 3]]);
    await send(new Date(t), "pageview", entry, arrival, device, ip, arrival.referrer);
    let page = entry;
    if (rand() < 0.08) await send(step(), "open-faq", page, arrival, device, ip, arrival.referrer, { question: pick([["price", 3], ["homebrew", 2], ["permissions", 2], ["spotify", 1]]) });
    if (device.mac && rand() < arrival.download * 1.4) {
      if (page !== "/download/") {
        await send(step(), "pageview", "/download/", arrival, device, ip, SITE + page);
        page = "/download/";
      }
      await send(step(), "download", page, arrival, device, ip, arrival.referrer, { file: "Notchlight.dmg" });
      downloads.push({ at: t, ip, arrival });
      if (rand() < 0.12) await send(step(), "download", page, arrival, device, ip, arrival.referrer, { file: "Notchlight.dmg" });
    }
    if (device.mac && rand() < arrival.checkout) {
      if (page !== "/") await send(step(), "pageview", "/", arrival, device, ip, SITE + page);
      await send(step(), "checkout", "/", arrival, device, ip, arrival.referrer, { ref: "stk_" + randomBytes(8).toString("hex") });
    }
    if (rand() < 0.05) await send(step(), "pageview", pick([["/privacy/", 2], ["/terms/", 1]]), arrival, device, ip, SITE + page);
    if (rand() < 0.015) await send(step(), "copy-homebrew", "/", arrival, device, ip, arrival.referrer);
  }
  // The day's download marks are written before its installs look for them, while the day's salt is still kept.
  await writer.flush();
  const firstRuns: { at: number; ip: string; buyRate: number }[] = downloads
    .filter(() => rand() < 0.72)
    .map((d) => ({ at: d.at + (2 + rand() * 38) * 60_000, ip: d.ip, buyRate: d.arrival.checkout * 3.5 }));
  for (let i = 0; i < Math.round(downloads.length * 0.12); i++) {
    const ip = pick(pools.get(pick(COUNTRIES))!.map((x): [string, number] => [x, 1]));
    firstRuns.push({ at: dayStart.getTime() + rand() * 86400_000, ip, buyRate: 0.15 });
  }
  for (const run of firstRuns.sort((a, b) => a.at - b.at)) if (run.at <= now) await newInstall(run.at, run.ip, run.buyRate);
}

// Each install's days after the first: used most days at first, less as the trial runs out, and every day once bought.
// Some buy within ten days; the rest expire after seven. Those on 1.4 update when 1.5 is out.
for (const install of installs) {
  let state = "trial";
  const buyOn = rand() < install.buyRate ? 1 + Math.floor(rand() * 10) : 0;
  for (let day = 1; ; day++) {
    const at = install.at + day * 86400_000 + (rand() - 0.5) * 6 * 3600_000;
    if (at > now) break;
    const chance = state === "licensed" ? 0.88 : state === "expired" ? 0.1 : 0.82 * 0.96 ** day;
    if (rand() > chance && day !== buyOn) continue;
    const events: { name: string; props?: object }[] = [{ name: "active" }];
    if (install.version === "1.4" && at >= RELEASE) {
      events.push({ name: "update", props: { from: "1.4" } });
      install.version = "1.5";
    }
    if (day === buyOn) {
      events.push({ name: "state", props: { from: state, to: "licensed" } });
      state = "licensed";
    } else if (state === "trial" && day >= 7) {
      events.push({ name: "state", props: { from: "trial", to: "expired" } });
      state = "expired";
    }
    if (rand() < 0.2) events.push({ name: "widget-added", props: { widget: pick([["weather", 3], ["music", 4], ["calendar", 2], ["battery", 1]]) } });
    await app(install, at, state, events);
  }
}
await writer.flush();
const { rows: [count] } = await pool.query("select count(*)::int as events, count(distinct session_id)::int as visits from events where project_id = $1", [project.id]);
const { rows: [apps] } = await pool.query("select count(*)::int as installs, count(source)::int as matched from installs where project_id = $1", [project.id]);
console.log(`${NAME} (${project.key}): ${count.visits} visits, ${apps.installs} installs (${apps.matched} matched to a visit), ${count.events} events in ${batches} app batches and the website's over ${DAYS} days`);
await pool.end();
