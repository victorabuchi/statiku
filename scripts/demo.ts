// Demo data for screenshots and the landing page's film: an account (demo@statiku.app, password "statiku demo") with
// Notchlight's website, about four months of visits, downloads, installs and sales (with what they earned), page
// speeds, scroll depths and script errors, a month of numbers sent from the app, and older history imported from
// Google Analytics and GitHub. Everything in it is made up. (Heatmap clicks come from scripts/shots.ts, which places
// them on the real page.) Only for a database named *demo* or *test*:
//   DATABASE_URL=postgres://localhost/statiku_demo node scripts/demo.ts
import pg from "pg";
import { hashPassword } from "../dashboard/auth.ts";
import { migrate } from "../db/migrate.ts";
import { createProject } from "./project.ts";

export const DEMO = { email: "demo@statiku.app", password: "statiku demo", name: "Victor Abuchi", domain: "notchlight.com" };

// The same numbers every run, so the screenshots only change when the app does.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(weighted: [T, number][]): T => {
  let r = random() * weighted.reduce((n, [, w]) => n + w, 0);
  for (const [value, w] of weighted) if ((r -= w) <= 0) return value;
  return weighted[0][0];
};
const id63 = () => BigInt(Math.floor(random() * 2 ** 52)) * 2048n + BigInt(Math.floor(random() * 2048));

const SOURCES: [string, string | null, number][] = [
  ["Google", "google.com", 30], ["Direct", null, 22], ["Hacker News", "news.ycombinator.com", 9], ["Reddit", "reddit.com", 8],
  ["Product Hunt", "producthunt.com", 6], ["X", "t.co", 5], ["MacUpdate", "macupdate.com", 4], ["YouTube", "youtube.com", 3],
  ["GitHub", "github.com", 3], ["ChatGPT", "chatgpt.com", 3], ["DuckDuckGo", "duckduckgo.com", 2], ["Bing", "bing.com", 2],
];
const COUNTRIES: [string, number][] = [
  ["US", 31], ["DE", 10], ["GB", 9], ["FI", 6], ["FR", 5], ["CA", 5], ["NL", 4], ["SE", 3], ["JP", 4], ["IN", 4], ["AU", 3], ["BR", 2], ["ES", 2], ["IT", 2], ["CH", 2], ["PL", 2],
];
const PAGES: [string, number][] = [["/", 50], ["/download", 18], ["/pricing", 12], ["/changelog", 7], ["/blog/notch-widgets", 6], ["/docs", 5], ["/privacy", 2]];
const DEVICES: [[string, string, string], number][] = [
  [["Laptop", "Safari", "macOS"], 34], [["Desktop", "Safari", "macOS"], 14], [["Laptop", "Chrome", "macOS"], 20], [["Desktop", "Chrome", "Windows"], 9],
  [["Laptop", "Firefox", "macOS"], 5], [["Mobile", "Safari", "iOS"], 12], [["Mobile", "Chrome", "Android"], 4], [["Tablet", "Safari", "iPadOS"], 2],
];

const DAYS = 120;

export async function demo(databaseUrl: string, log = console.log) {
  if (!/demo|test/.test(new URL(databaseUrl).pathname)) throw new Error("Demo data goes only into a database named *demo* or *test*.");
  await migrate(databaseUrl, () => {});
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("delete from users where email = $1", [DEMO.email]);
    await pool.query("delete from workspaces where name = 'Statiku demo'");
    const { rows: [user] } = await pool.query("insert into users (email, name, password_hash) values ($1, $2, $3) returning id", [DEMO.email, DEMO.name, await hashPassword(DEMO.password)]);
    const { rows: [workspace] } = await pool.query("insert into workspaces (name) values ('Statiku demo') returning id");
    await pool.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace.id, user.id]);
    const site = await createProject(pool, "Notchlight", [DEMO.domain], "Europe/Helsinki", workspace.id);
    await pool.query("update projects set ask_location = true, created_at = now() - make_interval(days => $2) where id = $1", [site.id, DAYS]);
    await pool.query("select ensure_month_partitions('events', 6, 2), ensure_month_partitions('sessions', 6, 2)");

    const sessions: unknown[][] = [], events: unknown[][] = [], installs: unknown[][] = [];
    const vitals: unknown[][] = [], scrolls: unknown[][] = [];
    // How each page tends to load and how far down it's read: the download page is heavy, the blog is long.
    const SPEED: Record<string, [number, number]> = { "/": [1700, 0.9], "/download": [3900, 1.4], "/pricing": [1500, 0.8], "/changelog": [1300, 0.6], "/blog/notch-widgets": [2300, 1.1], "/docs": [1400, 0.7], "/privacy": [900, 0.4] };
    const READ: Record<string, number> = { "/": 62, "/download": 80, "/pricing": 74, "/changelog": 41, "/blog/notch-widgets": 48, "/docs": 55, "/privacy": 30 };
    const now = Date.now();
    for (let d = DAYS; d >= 0; d--) {
      const date = new Date(now - d * 86400_000);
      const weekday = date.getUTCDay();
      // Growing, quieter at weekends, with a Product Hunt launch and a day on Hacker News.
      let visitors = 140 + (DAYS - d) * 2.4;
      if (weekday === 0 || weekday === 6) visitors *= 0.72;
      const launch = d === 46 ? 6 : d === 45 ? 2.5 : d === 13 ? 4.2 : d === 12 ? 1.8 : 1;
      visitors = Math.round(visitors * launch * (0.88 + random() * 0.24));
      if (d === 0) visitors = Math.round(visitors * ((new Date().getUTCHours() + 1) / 24));
      for (let v = 0; v < visitors; v++) {
        const visitor = id63(), session = id63();
        const [source, host] = launch > 3 && random() < 0.6 ? (d > 40 ? ["Product Hunt", "producthunt.com"] : ["Hacker News", "news.ycombinator.com"]) : pick(SOURCES.map(([s, h, w]) => [[s, h], w] as [[string, string | null], number]));
        const country = pick(COUNTRIES), [device, browser, os] = pick(DEVICES);
        const campaign = source === "Product Hunt" || (source === "X" && random() < 0.5) ? "launch-week" : null;
        const start = new Date(date);
        start.setUTCHours(d === 0 ? Math.floor(random() * Math.max(1, new Date().getUTCHours())) : Math.floor(random() * 24), Math.floor(random() * 60), Math.floor(random() * 60));
        if (start.getTime() > now) start.setTime(now - random() * 3600_000);
        let at = start.getTime();
        const pages = 1 + (random() < 0.55 ? Math.floor(random() * 4) : 0);
        let path = pick(PAGES), entry = path, exit = path;
        for (let p = 0; p < pages; p++) {
          if (p) {
            path = p === pages - 1 && random() < 0.5 ? "/download" : pick(PAGES);
            at += (20 + random() * 140) * 1000;
          }
          exit = path;
          events.push([site.id, new Date(at), "pageview", session, visitor, DEMO.domain, path, source, host, campaign ? "social" : null, campaign, country, device, browser, os, null, null]);
          // A month of speeds and scroll depths, for one view in three.
          if (d <= 30 && random() < 0.33) {
            const [lcp, slow] = SPEED[path] ?? [1500, 1];
            const mobile = device === "Mobile" ? 1.5 : 1;
            vitals.push([site.id, new Date(at + 20_000), path, device, Math.round(lcp * mobile * (0.6 + random() * random() * 1.8)), Math.round((60 + random() * 180) * slow * mobile),
              Math.round(random() * random() * 0.22 * slow * 1000) / 1000, Math.round((180 + random() * 420) * mobile), 200]);
            scrolls.push([site.id, new Date(at + 20_000), path, device, Math.max(8, Math.min(100, Math.round((READ[path] ?? 50) + (random() - 0.5) * 70)))]);
          }
        }
        const downloaded = (path === "/download" || pages > 2) && os === "macOS" && random() < 0.55;
        if (downloaded) {
          at += 8000;
          events.push([site.id, new Date(at), "download", session, visitor, DEMO.domain, "/download", source, host, null, campaign, country, device, browser, os, { file: "Notchlight.dmg" }, null]);
          if (random() < 0.62) {
            const first = new Date(at + (60 + random() * 600) * 1000);
            const trial = random() < 0.7 ? new Date(first.getTime() + 120_000) : null;
            const licensed = trial && random() < 0.16 ? new Date(trial.getTime() + random() * 9 * 86400_000) : null;
            if (licensed && licensed.getTime() > now) licensed.setTime(now - 3600_000);
            const state = licensed ? "licensed" : trial ? (now - trial.getTime() > 7 * 86400_000 ? "expired" : "trial") : "free";
            installs.push([site.id, crypto.randomUUID(), first, new Date(Math.min(now, first.getTime() + random() * d * 86400_000)), "macOS", pick([["2.4.1", 5], ["2.4.0", 3], ["2.3.2", 1]]), "241", pick([["26.1", 5], ["15.6", 3], ["14.7", 1]]), state, trial, licensed, country, session, source, host, null, campaign]);
          }
        }
        if (path === "/pricing" && random() < 0.18) {
          at += 15000;
          events.push([site.id, new Date(at), "checkout", session, visitor, DEMO.domain, "/pricing", source, host, null, campaign, country, device, browser, os, null, null]);
          // Most checkouts end in a sale: a year of Notchlight Pro, or a lifetime licence.
          if (random() < 0.62) {
            at += 90_000;
            events.push([site.id, new Date(at), "purchase", session, visitor, DEMO.domain, "/pricing", source, host, null, campaign, country, device, browser, os, { via: "polar" }, random() < 0.7 ? 1900 : 4900]);
          }
        }
        if (random() < 0.04) events.push([site.id, new Date(at + 5000), "newsletter_signup", session, visitor, DEMO.domain, path, source, host, null, campaign, country, device, browser, os, { form: "footer" }, null]);
        sessions.push([site.id, session, visitor, start, new Date(at + 30_000 * random()), entry, exit, pages, pages, source, host, campaign ? "social" : null, campaign, country, device, browser, os]);
      }
    }
    const insert = async (table: string, columns: string[], types: string[], rows: unknown[][]) => {
      for (let i = 0; i < rows.length; i += 5000) {
        const chunk = rows.slice(i, i + 5000);
        await pool.query(
          `insert into ${table} (${columns.join(", ")}) select * from unnest(${types.map((t, j) => `$${j + 1}::${t}[]`).join(", ")})`,
          columns.map((_, j) => chunk.map((r) => (r[j] && typeof r[j] === "object" && !(r[j] instanceof Date) ? JSON.stringify(r[j]) : r[j]))),
        );
      }
    };
    await insert("sessions", ["project_id", "id", "visitor", "started_at", "last_seen", "entry_path", "exit_path", "pageviews", "events", "source", "referrer_host", "utm_medium", "utm_campaign", "country", "device", "browser", "os"],
      ["uuid", "bigint", "bigint", "timestamptz", "timestamptz", "text", "text", "int", "int", "text", "text", "text", "text", "text", "text", "text", "text"], sessions);
    await insert("events", ["project_id", "ts", "name", "session_id", "visitor", "hostname", "path", "source", "referrer_host", "utm_medium", "utm_campaign", "country", "device", "browser", "os", "props", "revenue_minor", "currency"],
      ["uuid", "timestamptz", "text", "bigint", "bigint", "text", "text", "text", "text", "text", "text", "text", "text", "text", "text", "jsonb", "bigint", "text"], events.map((e) => [...e, e[16] ? "EUR" : null]));
    await insert("vitals", ["project_id", "ts", "path", "device", "lcp", "inp", "cls", "ttfb", "status"], ["uuid", "timestamptz", "text", "text", "int", "int", "real", "int", "smallint"], vitals);
    await insert("scrolls", ["project_id", "ts", "path", "device", "depth"], ["uuid", "timestamptz", "text", "text", "smallint"], scrolls);
    // Visits to an old post that has gone (it answers 404), and the scripts' errors visitors hit.
    await insert("vitals", ["project_id", "ts", "path", "device", "lcp", "inp", "cls", "ttfb", "status"], ["uuid", "timestamptz", "text", "text", "int", "int", "real", "int", "smallint"],
      Array.from({ length: 40 }, () => [site.id, new Date(now - random() * 30 * 86400_000), "/blog/notch-tips", "Laptop", 900, null, 0, 300, 404]));
    const BUGS: [string, string, number, string, string, number][] = [
      ["TypeError: Cannot read properties of undefined (reading 'version')", "https://notchlight.com/assets/download.js", 214, "/download", "Chrome", 46],
      ["ResizeObserver loop completed with undelivered notifications.", "https://notchlight.com/assets/site.js", 88, "/", "Safari", 21],
      ["Unhandled promise rejection: Failed to fetch", "https://notchlight.com/assets/pricing.js", 31, "/pricing", "Firefox", 7],
    ];
    await insert("page_errors", ["project_id", "ts", "path", "message", "source", "line", "browser"], ["uuid", "timestamptz", "text", "text", "text", "int", "text"],
      BUGS.flatMap(([message, src, line, path, browser, n]) => Array.from({ length: n }, () => [site.id, new Date(now - random() * 30 * 86400_000), path, message, src, line, browser])));

    // Numbers the app sends: Macs using Notchlight each day, widgets added, crash-free sessions, the App Store rating.
    const points: unknown[][] = [];
    for (let h = 30 * 24; h >= 0; h--) {
      const at = new Date(now - h * 3600_000), day = 30 - h / 24;
      if (h % 24 === 0) {
        points.push(["Active Macs", at, Math.round(1240 + day * 31 + random() * 60)]);
        points.push(["Crash-free sessions (%)", at, Math.round((99.2 + random() * 0.7) * 10) / 10]);
        points.push(["App Store rating", at, Math.round((4.6 + day / 150 + random() * 0.05) * 10) / 10]);
      }
      // Widgets added, each labelled with which widget it was.
      for (const [widget, w] of [["Calendar", 5], ["Music", 4], ["Weather", 3], ["Timers", 2], ["Notes", 1]] as const) {
        points.push(["Widgets added", at, Math.round((w + random() * w * 1.6) * (at.getUTCHours() > 7 && at.getUTCHours() < 22 ? 1.8 : 0.7)), null, { widget }]);
      }
    }
    // A tracker of words: the update server's status, now and then degraded.
    let status = "Online";
    for (let h = 30 * 24; h >= 0; h -= 3) {
      const next = random() < 0.06 ? "Degraded" : random() < 0.01 ? "Offline" : "Online";
      if (next !== status || h % 24 === 0) points.push(["Update server", new Date(now - h * 3600_000), null, next, null]);
      status = next;
    }
    await pool.query("insert into metrics (project_id, name, kind) values ($1, 'Active Macs', 'set'), ($1, 'Crash-free sessions (%)', 'set'), ($1, 'App Store rating', 'set'), ($1, 'Widgets added', 'add'), ($1, 'Update server', 'text')", [site.id]);
    await insert("metric_points", ["project_id", "name", "ts", "value", "text_value", "props"], ["uuid", "text", "timestamptz", "float8", "text", "jsonb"],
      points.map(([name, at, value, text = null, props = null]) => [site.id, name, at, typeof value === "number" || value === null ? value : null, text ?? (typeof value === "string" ? value : null), props]));
    await insert("installs", ["project_id", "id", "first_seen", "last_seen", "platform", "app_version", "build", "os_version", "state", "trial_at", "licensed_at", "country", "session_id", "source", "referrer_host", "utm_medium", "utm_campaign"],
      ["uuid", "uuid", "timestamptz", "timestamptz", "text", "text", "text", "text", "text", "timestamptz", "timestamptz", "text", "bigint", "text", "text", "text", "text"], installs);
    await pool.query(
      `insert into usage_daily (project_id, day, events) select project_id, (ts at time zone 'utc')::date, count(*) from events where project_id = $1 group by 1, 2
       on conflict (project_id, day) do update set events = excluded.events`,
      [site.id],
    );

    // A year of history from before, as if imported from Google Analytics, and the app's GitHub releases.
    const { rows: [ga] } = await pool.query(
      `insert into imports (project_id, kind, label, status, created_by, finished_at) values ($1, 'ga4', 'Google Analytics: notchlight.com (GA4 314159265)', 'done', $2, now()) returning id`,
      [site.id, user.id],
    );
    const history: unknown[][] = [];
    for (let d = DAYS + 365; d > DAYS; d--) {
      const day = new Date(now - d * 86400_000).toISOString().slice(0, 10);
      const visitors = Math.round((40 + (DAYS + 365 - d) * 0.27) * (0.85 + random() * 0.3));
      const visits = Math.round(visitors * 1.18), pageviews = Math.round(visits * 2.1);
      history.push([day, "total", "", visitors, visits, pageviews, Math.round(visits * 0.46), visits * 74, visits]);
      for (const [source, , w] of SOURCES.slice(0, 7)) history.push([day, "source", source, Math.round((visitors * w) / 89), 0, 0, 0, 0, 0]);
      for (const [country, w] of COUNTRIES.slice(0, 8)) history.push([day, "country", country, Math.round((visitors * w) / 72), 0, 0, 0, 0, 0]);
      for (const [page, w] of PAGES) history.push([day, "page", page, Math.round((visitors * w) / 100), 0, Math.round((pageviews * w) / 100), 0, 0, 0]);
    }
    await pool.query(
      `insert into imported_days (import_id, project_id, day, dimension, value, visitors, visits, pageviews, bounces, duration, measured)
       select $1, $2, * from unnest($3::date[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[], $10::bigint[], $11::int[])`,
      [ga.id, site.id, ...Array.from({ length: 9 }, (_, j) => history.map((r) => r[j]))],
    );
    const { rows: [gh] } = await pool.query(
      `insert into imports (project_id, kind, label, status, created_by, finished_at, config) values ($1, 'github', 'GitHub: victorabuchi/notchlight', 'done', $2, now(), $3) returning id`,
      [site.id, user.id, JSON.stringify({ repo: "victorabuchi/notchlight", counts: {}, refreshedAt: new Date(now - 2 * 3600_000).toISOString() })],
    );
    for (const [tag, ago, downloads] of [["v2.4.1", 9, 1840], ["v2.4.0", 31, 3120], ["v2.3.2", 58, 2210], ["v2.3.0", 96, 1680], ["v2.2.0", 170, 940], ["v2.0.0", 300, 610]] as const) {
      const day = new Date(now - ago * 86400_000).toISOString().slice(0, 10);
      await pool.query(
        `insert into imported_days (import_id, project_id, day, dimension, value, downloads) values ($1, $2, $3, 'release', $4, $5), ($1, $2, $3, 'releases', '', $5)
         on conflict (import_id, dimension, value, day) do update set downloads = imported_days.downloads + excluded.downloads`,
        [gh.id, site.id, day, tag, downloads],
      );
    }
    await pool.query(
      `update imports i set rows = (select count(*) from imported_days d where d.import_id = i.id), first_day = (select min(day) from imported_days d where d.import_id = i.id),
              last_day = (select max(day) from imported_days d where d.import_id = i.id) where i.project_id = $1`,
      [site.id],
    );
    log(`Demo: ${sessions.length} visits, ${events.length} events, ${installs.length} installs for ${DEMO.domain} (${site.key}). Sign in as ${DEMO.email} / ${DEMO.password}.`);
    return { siteKey: site.key, siteId: site.id };
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to a database named *demo*");
  await demo(process.env.DATABASE_URL);
}
