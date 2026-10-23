// 30 days of made-up visits to a Notchlight-like site, sent through the real collection code (sessions, sources,
// countries, devices), so the dashboard has something to show locally. Reruns replace the demo project's data.
//   npm run seed
import { randomBytes } from "node:crypto";
import pg from "pg";
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
for (const table of ["events", "sessions", "usage_daily"]) await pool.query(`delete from ${table} where project_id = $1`, [project.id]);

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

const now = Date.now();
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
      if (rand() < 0.12) await send(step(), "download", page, arrival, device, ip, arrival.referrer, { file: "Notchlight.dmg" });
    }
    if (device.mac && rand() < arrival.checkout) {
      if (page !== "/") await send(step(), "pageview", "/", arrival, device, ip, SITE + page);
      await send(step(), "checkout", "/", arrival, device, ip, arrival.referrer, { ref: "stk_" + randomBytes(8).toString("hex") });
    }
    if (rand() < 0.05) await send(step(), "pageview", pick([["/privacy/", 2], ["/terms/", 1]]), arrival, device, ip, SITE + page);
    if (rand() < 0.015) await send(step(), "copy-homebrew", "/", arrival, device, ip, arrival.referrer);
  }
}
await writer.flush();
const { rows: [count] } = await pool.query("select count(*)::int as events, count(distinct session_id)::int as visits from events where project_id = $1", [project.id]);
console.log(`${NAME} (${project.key}): ${count.visits} visits, ${count.events} events over ${DAYS} days`);
await pool.end();
