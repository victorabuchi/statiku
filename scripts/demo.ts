// Demo data for screenshots and the landing page's film: an account (demo@statiku.app, password "statiku demo") with
// Notchlight's website, about four months of visits, downloads, installs and sales, and older history imported from
// Google Analytics and GitHub. Everything in it is made up. Only for a database named *demo* or *test*:
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
    await insert("events", ["project_id", "ts", "name", "session_id", "visitor", "hostname", "path", "source", "referrer_host", "utm_medium", "utm_campaign", "country", "device", "browser", "os", "props", "revenue_minor"],
      ["uuid", "timestamptz", "text", "bigint", "bigint", "text", "text", "text", "text", "text", "text", "text", "text", "text", "text", "jsonb", "bigint"], events);
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
