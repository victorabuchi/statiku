// Statiku's newer measures against a real Postgres: numbers sent from anywhere, the match view, momentum, assists,
// player ratings, match reports, heatmaps, injuries, revenue by source and "what changed". Needs TEST_DATABASE_URL
// (createdb statiku_test); the test empties that database first.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { parseNumbers } from "../ingest/numbers.ts";
import { parseNumbersFile } from "../dashboard/numbers.ts";
import { createApp } from "../ingest/server.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : !/test/.test(url) ? "TEST_DATABASE_URL must name a test database" : false;
export const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";

let app: Awaited<ReturnType<typeof createApp>>;
let pool: pg.Pool;
let base: string;
const mailbox: { to: string; subject: string; text: string }[] = [];
const slack: { url: string; body: any }[] = [];

before(async () => {
  if (skip) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("drop schema public cascade; create schema public");
  await admin.end();
  await migrate(url!, () => {});
  pool = new pg.Pool({ connectionString: url });
  app = await createApp({
    databaseUrl: url!, trustProxy: true, geoPath: new URL("../data/country.mmdb", import.meta.url), flushMs: 60_000,
    mailer: async (mail) => void mailbox.push(mail),
    probe: async () => ({ error: "ENOTFOUND" }),
    fetchIcon: async () => null,
  });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await app.close();
  await pool.end();
});

let browsers = 0;
function browser() {
  const ip = `82.17.${++browsers}.1`;
  let cookie = "";
  return async (path: string, { method = "GET", body, form }: { method?: string; body?: unknown; form?: FormData } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  };
}

let people = 0;
async function siteOf(domain: string) {
  const as = browser();
  assert.equal((await as("/api/signup", { method: "POST", body: { name: "Victor", email: `owner${++people}@example.com`, password: "correct horse battery" } })).status, 201);
  const added = await as("/api/sites", { method: "POST", body: { address: domain, timezone: "Europe/Helsinki" } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const { rows: [row] } = await pool.query("select id from projects where key = $1", [added.data.site.key]);
  return { as, key: added.data.site.key as string, id: row.id as string };
}

const sendNumber = (body: unknown, key: string | null, query = "") =>
  fetch(`${base}/v1/number${query}`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

test("numbers: parsing one, a list, and what isn't one", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  assert.deepEqual(parseNumbers('{"name": " Home  goals ", "value": "2"}', new URLSearchParams(), now), [{ name: "Home goals", value: 2, ts: now, op: null }]);
  const list = parseNumbers(JSON.stringify({ numbers: [{ name: "Installs", value: 1, op: "add", ts: 1793872800 }, { name: "Temp", value: -3.5, ts: "2026-11-05T10:00:00Z" }] }), new URLSearchParams(), now);
  assert.ok(Array.isArray(list));
  assert.equal(list[0].ts.toISOString(), "2026-11-05T10:00:00.000Z");
  assert.equal(list[0].op, "add");
  assert.deepEqual(parseNumbers("", new URLSearchParams("name=Score&value=3"), now), [{ name: "Score", value: 3, ts: now, op: null }]);
  assert.match(String(parseNumbers('{"name": "x"}', new URLSearchParams(), now)), /needs a number/);
  assert.match(String(parseNumbers('{"value": 1}', new URLSearchParams(), now)), /missing name/);
  assert.match(String(parseNumbers('{"name": "x", "value": 1, "ts": "2030-01-01"}', new URLSearchParams(), now)), /future/);
  assert.match(String(parseNumbers("nope", new URLSearchParams(), now)), /not JSON/);
  assert.match(String(parseNumbers(JSON.stringify(Array(101).fill({ name: "a", value: 1 })), new URLSearchParams(), now)), /at most 100/);
});

test("numbers: files with a row per value, or a column per number", () => {
  const long = parseNumbersFile("time,name,value\n2026-11-01,Home goals,1\n2026-11-02T18:30,Home goals,3\n2026-11-02,Away goals,0\n");
  assert.ok(typeof long !== "string");
  assert.equal(long.points.length, 3);
  assert.equal(long.points[1].ts.toISOString(), "2026-11-02T18:30:00.000Z");
  const wide = parseNumbersFile("date;Temperature;Humidity\n2026-11-01;21,5;40\n2026-11-02;22;\n");
  assert.ok(typeof wide !== "string");
  assert.deepEqual(wide.points.map((p) => [p.name, p.value]), [["Temperature", 21.5], ["Humidity", 40], ["Temperature", 22]]);
  assert.match(String(parseNumbersFile("name,value\nx,1\n")), /time/);
  assert.match(String(parseNumbersFile("time,name,value\nyesterday,x,1\n")), /Line 2/);
});

test("numbers: sent with the site's key, shown per period, live, from a file, and deleted", { skip }, async () => {
  const { as, key, id } = await siteOf("numbers.example");
  assert.equal((await sendNumber({ name: "x", value: 1 }, null)).status, 401);
  assert.equal((await sendNumber({ name: "x", value: 1 }, "sn_nope")).status, 401);
  const made = await as(`/api/sites/${key}/numbers/key`, { method: "POST" });
  assert.equal(made.status, 200);
  assert.match(made.data.key, /^sn_[\w-]{30,}$/);
  const secret = made.data.key;
  // The key is kept only as a hash.
  const { rows: [stored] } = await pool.query("select numbers_key_hash from projects where id = $1", [id]);
  assert.notEqual(stored.numbers_key_hash, secret);

  const heard: any[] = [];
  const stop = app.deps.hub.subscribe(id, (m) => heard.push(JSON.parse(m)));
  const one = await sendNumber({ name: "Home goals", value: 1 }, secret);
  assert.equal(one.status, 202, one.text);
  assert.deepEqual(JSON.parse(one.text), { ok: true, saved: 1 });
  assert.equal((await sendNumber({ name: "Home goals", value: 2 }, secret)).status, 202);
  assert.equal((await sendNumber([{ name: "Installs", value: 1, op: "add" }, { name: "Installs", value: 3 }], secret)).status, 202);
  // A device that can only open an address.
  assert.equal((await fetch(`${base}/v1/number?key=${secret}&name=Temperature&value=21.5`)).status, 202);
  assert.equal((await sendNumber({ name: "Temperature" }, secret)).status, 400);
  stop();
  assert.deepEqual(heard.filter((m) => m.t === "number").map((m) => [m.n.name, m.n.value, m.n.kind]), [
    ["Home goals", 1, "set"], ["Home goals", 2, "set"], ["Installs", 1, "add"], ["Installs", 3, "add"], ["Temperature", 21.5, "set"],
  ]);

  await app.writer.flush();
  const report = await as(`/api/sites/${key}/numbers?range=today`);
  assert.equal(report.status, 200);
  assert.equal(report.data.hasKey, true);
  const by = Object.fromEntries(report.data.numbers.map((n: any) => [n.name, n]));
  assert.equal(by["Home goals"].value, 2);
  assert.equal(by["Home goals"].kind, "set");
  assert.equal(by.Installs.value, 4);
  assert.equal(by.Installs.kind, "add");
  assert.equal(by.Temperature.value, 21.5);
  assert.equal(by.Installs.series.reduce((sum: number, p: any) => sum + (p.v ?? 0), 0), 4);
  // Numbers count towards the site's events.
  const { rows: [use] } = await pool.query("select coalesce(sum(events), 0)::int as n from usage_daily where project_id = $1", [id]);
  assert.equal(use.n, 5);

  const form = new FormData();
  form.append("file", new Blob(["time,Away goals\n2026-11-01,1\n2026-11-02,2\n"]), "match.csv");
  const uploaded = await as(`/api/sites/${key}/numbers/upload`, { method: "POST", form });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.deepEqual(uploaded.data, { saved: 2, names: ["Away goals"] });
  const all = await as(`/api/sites/${key}/numbers?range=all`);
  assert.equal(all.data.numbers.find((n: any) => n.name === "Away goals").value, 2);

  assert.equal((await as(`/api/sites/${key}/numbers/${encodeURIComponent("Away goals")}`, { method: "DELETE" })).status, 200);
  assert.equal((await as(`/api/sites/${key}/numbers?range=all`)).data.numbers.some((n: any) => n.name === "Away goals"), false);

  // A new key: the old one stops working at once.
  const renewed = (await as(`/api/sites/${key}/numbers/key`, { method: "POST" })).data.key;
  assert.equal((await sendNumber({ name: "x", value: 1 }, secret)).status, 401);
  assert.equal((await sendNumber({ name: "x", value: 1 }, renewed)).status, 202);
  // Someone else's account can't see or change them.
  const stranger = (await siteOf("stranger.example")).as;
  assert.equal((await stranger(`/api/sites/${key}/numbers`)).status, 404);
});

const hit = (key: string, ip: string, n: string, u: string, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/e`, {
    method: "POST",
    headers: { "user-agent": SAFARI, "x-forwarded-for": ip },
    body: JSON.stringify({ k: key, n, u, r: "https://news.ycombinator.com/", w: 1440, ...extra }),
  }).then((r) => r.status);

test("the match view: today's scoreboard, goals, takings, commentary and momentum, signed in or at a shared link", { skip }, async () => {
  const { as, key } = await siteOf("match.example");
  assert.equal(await hit(key, "203.0.113.10", "pageview", "https://match.example/"), 202);
  assert.equal(await hit(key, "203.0.113.10", "signup", "https://match.example/join"), 202);
  assert.equal(await hit(key, "203.0.113.11", "pageview", "https://match.example/pricing"), 202);
  assert.equal(await hit(key, "203.0.113.11", "purchase", "https://match.example/pricing", { $: { amount: 49, currency: "EUR" } }), 202);
  assert.equal(await hit(key, "203.0.113.12", "pageview", "https://match.example/blog"), 202);
  assert.equal(await hit(key, "203.0.113.12", "newsletter", "https://match.example/blog"), 202);
  await app.writer.flush();

  const board = await as(`/api/sites/${key}/match`);
  assert.equal(board.status, 200, JSON.stringify(board.data));
  assert.equal(board.data.today.visitors, 3);
  // A sign-up and a sale are goals; a newsletter isn't one of the usual ones.
  assert.equal(board.data.today.goals, 2);
  assert.deepEqual(board.data.today.takings, [{ currency: "EUR", minor: 4900 }]);
  const kinds = board.data.commentary.map((c: any) => `${c.kind}:${c.name ?? c.path}:${c.goal}`);
  assert.ok(kinds.includes("event:signup:true") && kinds.includes("event:purchase:true") && kinds.includes("event:newsletter:false"), kinds.join(" "));
  assert.equal(board.data.commentary.filter((c: any) => c.kind === "visit").length, 3);
  assert.equal(board.data.commentary.find((c: any) => c.name === "purchase").revenue.minor, 4900);
  assert.equal(board.data.momentum.wave.length, 24);
  assert.equal(board.data.momentum.wave.at(-1).now, 3);
  assert.deepEqual(board.data.momentum.sources, [{ source: "Hacker News", now: 3, before: 0 }]);
  assert.equal((await as(`/api/sites/${key}/momentum`)).data.wave.length, 24);

  // A site's own goals replace the usual ones.
  assert.equal((await as(`/api/sites/${key}`, { method: "PATCH", body: { goals: "newsletter, purchase" } })).status, 200);
  const own = await as(`/api/sites/${key}/match`);
  assert.deepEqual(own.data.goals, ["newsletter", "purchase"]);
  assert.equal(own.data.today.goals, 2);
  assert.deepEqual((await as(`/api/sites/${key}`)).data.site.goals, ["newsletter", "purchase"]);

  // Shared at a link of its own: anyone sees the scoreboard, and the live feed without visitors' device details.
  assert.equal((await fetch(`${base}/api/match/${"x".repeat(24)}`)).status, 404);
  const link = await as(`/api/sites/${key}/match/link`, { method: "POST" });
  const token = link.data.url.split("/m/")[1];
  assert.match(link.data.url, /\/m\/[\w-]{24}$/);
  const outside = await fetch(`${base}/api/match/${token}`).then((r) => r.json());
  assert.equal(outside.today.goals, 2);
  assert.equal(outside.site.name, "match.example");
  const stream = await fetch(`${base}/api/match/${token}/stream`);
  const reader = stream.body!.getReader();
  await hit(key, "203.0.113.13", "pageview", "https://match.example/live");
  let text = "";
  for (let i = 0; i < 20 && !text.includes('"t":"event"'); i++) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const event = JSON.parse(text.split("\n").find((l) => l.includes('"t":"event"'))!.slice(6)).e;
  assert.equal(event.path, "/live");
  assert.equal(event.first, true);
  assert.equal("device" in event || "browser" in event, false);
  // The page itself is the app, for anyone.
  assert.equal((await fetch(`${base}/m/${token}`)).status, 200);
  assert.equal((await as(`/api/sites/${key}/match/link`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/match/${token}`)).status, 404);
});

// Visits written as they'd have been over a morning, which the service can't be made to wait for: a visitor's second
// visit needs half an hour's gap.
async function morning(projectId: string, visits: { visitor: number; source: string; at: number; pages: [number, string][]; goal?: [number, string, number?] }[]) {
  const dayStart = new Date(Date.now() - 3 * 3600_000);
  dayStart.setUTCHours(0, 0, 0, 0);
  const t = (min: number) => new Date(dayStart.getTime() + min * 60_000);
  let id = 1000 + Math.floor(Math.random() * 1e6);
  for (const v of visits) {
    const session = ++id;
    const last = Math.max(...v.pages.map(([m]) => m), v.goal?.[0] ?? 0);
    await pool.query(
      `insert into sessions (project_id, id, visitor, started_at, last_seen, entry_path, exit_path, pageviews, events, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [projectId, session, v.visitor, t(v.at), t(last + 1), v.pages[0][1], v.pages.at(-1)![1], v.pages.length, v.pages.length + (v.goal ? 1 : 0), v.source],
    );
    for (const [m, path] of v.pages) {
      await pool.query("insert into events (project_id, ts, name, session_id, visitor, path, source) values ($1, $2, 'pageview', $3, $4, $5, $6)", [projectId, t(m), session, v.visitor, path, v.source]);
    }
    if (v.goal) {
      await pool.query("insert into events (project_id, ts, name, session_id, visitor, path, source, revenue_minor, currency) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [projectId, t(v.goal[0]), v.goal[1], session, v.visitor, v.pages.at(-1)![1], v.source, v.goal[2] ?? null, v.goal[2] ? "EUR" : null]);
    }
  }
}

test("assists and player ratings: which pages and visits led to each goal, and how each page played", { skip }, async () => {
  const { as, key, id } = await siteOf("assists.example");
  await morning(id, [
    // Found the site on Google, came back from Hacker News an hour later and signed up.
    { visitor: 1, source: "Google", at: 10, pages: [[10, "/"], [12, "/features"]] },
    { visitor: 1, source: "Hacker News", at: 70, pages: [[70, "/pricing"]], goal: [75, "signup"] },
    // Bought in one visit from Google.
    { visitor: 2, source: "Google", at: 20, pages: [[20, "/"], [23, "/pricing"]], goal: [26, "purchase", 1900] },
    // Read one post and left.
    { visitor: 3, source: "X", at: 30, pages: [[30, "/blog"]] },
    { visitor: 4, source: "X", at: 40, pages: [[40, "/blog"]] },
  ]);
  const got = await as(`/api/sites/${key}/insights?range=d7`);
  assert.equal(got.status, 200, JSON.stringify(got.data));
  const a = got.data.assists;
  assert.equal(a.goals, 2);
  assert.equal(a.multiVisit, 1);
  assert.deepEqual(Object.fromEntries(a.pages.map((p: any) => [p.label, p.v])), { "/": 2, "/pricing": 2, "/features": 1 });
  assert.deepEqual(a.sources.map((s: any) => [s.label, s.scored, s.assisted, s.opened]), [["Google", 1, 1, 2], ["Hacker News", 1, 0, 0]]);
  const r = got.data.ratings.pages;
  const rating = (path: string) => r.find((p: any) => p.path === path).rating;
  assert.ok(r.every((p: any) => p.rating >= 1 && p.rating <= 10));
  assert.ok(rating("/pricing") > rating("/blog"), JSON.stringify(r));
  assert.equal(r.find((p: any) => p.path === "/blog").exitRate, 100);
  assert.equal(r.find((p: any) => p.path === "/pricing").assists, 2);
});
