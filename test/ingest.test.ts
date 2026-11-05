// The ingest service end to end against a real Postgres. Needs TEST_DATABASE_URL (createdb statiku_test); the test
// empties that database first.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { createProject } from "../scripts/project.ts";
import { clientIp, createApp } from "../ingest/server.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : !/test/.test(url) ? "TEST_DATABASE_URL must name a test database" : false;

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:144.0) Gecko/20100101 Firefox/144.0";
const FINNISH_IP = "193.166.3.2";

let app: Awaited<ReturnType<typeof createApp>>;
let pool: pg.Pool;
let base: string;
let key: string;

before(async () => {
  if (skip) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("drop schema public cascade; create schema public");
  await admin.end();
  await migrate(url!, () => {});
  pool = new pg.Pool({ connectionString: url });
  key = (await createProject(pool, "Notchlight", ["notchlight.com"], "Europe/Helsinki")).key;
  app = await createApp({ databaseUrl: url!, trustProxy: true, geoPath: new URL("../data/country.mmdb", import.meta.url), flushMs: 60_000 });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  await app.close();
  await pool.end();
});

function post(body: unknown, ua = SAFARI, ip = FINNISH_IP) {
  return fetch(`${base}/e`, {
    method: "POST",
    // What the proxy in front adds to the end is the client; anything before it the client could have written.
    headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": ua, "x-forwarded-for": `10.0.0.1, ${ip}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const hit = (n: string, u: string, extra: object = {}) => ({ k: key, n, u, r: null, w: 1512, ...extra });

test("serves the script", { skip }, async () => {
  const res = await fetch(`${base}/s.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /javascript/);
  assert.ok((await res.text()).length < 10_240);
  const again = await fetch(`${base}/s.js`, { headers: { "if-none-match": res.headers.get("etag")! } });
  assert.equal(again.status, 304);
});

test("a visit: its source, its session, its events", { skip }, async () => {
  const first = await post(hit("pageview", "https://notchlight.com/?utm_source=macnative&utm_medium=listing&email=me@x.com", { r: "https://macnative.io/apps" }));
  assert.equal(first.status, 202);
  assert.equal(first.headers.get("access-control-allow-origin"), "*");
  await post(hit("pageview", "https://notchlight.com/download/", { r: "https://notchlight.com/" }));
  await post(hit("download", "https://notchlight.com/download/", { p: { file: "Notchlight.dmg" } }));
  await post(hit("checkout", "https://notchlight.com/", { p: { ref: "stk_abc123" } }));
  // Another browser on the same network is another visitor.
  await post(hit("pageview", "https://www.notchlight.com/", { r: "https://www.google.com/" }), FIREFOX);
  await app.writer.flush();

  const sessions = (await pool.query("select * from sessions order by started_at")).rows;
  assert.equal(sessions.length, 2);
  const [visit, other] = sessions;
  assert.equal(visit.source, "MacNative");
  assert.equal(visit.referrer_host, "macnative.io");
  assert.equal(visit.utm_medium, "listing");
  assert.equal(visit.country, "FI");
  assert.equal(visit.browser, "Safari");
  assert.equal(visit.device, "Desktop");
  assert.equal(visit.entry_path, "/");
  assert.equal(visit.exit_path, "/download/");
  assert.equal(visit.pageviews, 2);
  assert.equal(visit.events, 4);
  assert.equal(other.source, "Google");
  assert.equal(other.browser, "Firefox");
  assert.notEqual(other.visitor, visit.visitor);

  const events = (await pool.query("select * from events where session_id = $1 order by ts", [visit.id])).rows;
  assert.deepEqual(events.map((e) => e.name), ["pageview", "pageview", "download", "checkout"]);
  // Every event carries the session's source, so the download counts for MacNative.
  assert.ok(events.every((e) => e.source === "MacNative"));
  assert.deepEqual(events[2].props, { file: "Notchlight.dmg" });
  assert.deepEqual(events[3].props, { ref: "stk_abc123" });
  // The query string is gone apart from the tags.
  assert.equal(events[0].path, "/");

  const usage = (await pool.query("select events from usage_daily")).rows;
  assert.equal(Number(usage[0].events), 5);
});

test("no IP, query string or user agent is stored anywhere", { skip }, async () => {
  const { rows: tables } = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  );
  for (const { table_name } of tables) {
    const dump = JSON.stringify((await pool.query(`select * from ${table_name}`)).rows);
    for (const secret of [FINNISH_IP, "10.0.0.1", "me@x.com", "Version/26.1"]) assert.ok(!dump.includes(secret), `${secret} in ${table_name}`);
  }
});

test("a session ends after 30 minutes and resumes from the database after a restart", { skip }, async () => {
  const { collect } = await import("../ingest/collect.ts");
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const t0 = new Date();
  const body = (n: string, u: string) => JSON.stringify(hit(n, u));
  await collect(app.deps, body("pageview", "https://notchlight.com/"), ua, "81.17.200.1", t0);
  await app.writer.flush();
  // A restart: the in-memory sessions are gone, the next event finds the open one in the database.
  app.deps.sessions.live.clear();
  await collect(app.deps, body("pageview", "https://notchlight.com/terms/"), ua, "81.17.200.1", new Date(t0.getTime() + 60_000));
  // 31 minutes later: a new session.
  await collect(app.deps, body("pageview", "https://notchlight.com/"), ua, "81.17.200.1", new Date(t0.getTime() + 32 * 60_000));
  await app.writer.flush();
  const { rows } = await pool.query("select pageviews, exit_path from sessions where browser = 'Chrome' order by started_at");
  assert.deepEqual(rows, [{ pageviews: 2, exit_path: "/terms/" }, { pageviews: 1, exit_path: "/" }]);
});

test("refuses what doesn't belong and drops bots", { skip }, async () => {
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(hit("pageview", "https://notchlight.com/", { k: "p_nope" }))).status, 404);
  const foreign = await post(hit("pageview", "https://copycat.dev/"));
  assert.equal(foreign.status, 403);
  assert.match(await foreign.text(), /copycat\.dev/);
  assert.equal((await post("x".repeat(9000))).status, 413);
  const before = (await pool.query("select count(*)::int as n from events")).rows[0].n;
  assert.equal((await post(hit("pageview", "https://notchlight.com/"), "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).status, 202);
  await app.writer.flush();
  assert.equal((await pool.query("select count(*)::int as n from events")).rows[0].n, before);
});

test("the client is the address the proxy saw, not one it wrote itself", () => {
  const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: "10.9.9.9" } }) as unknown as import("node:http").IncomingMessage;
  const sent = { "x-forwarded-for": "203.0.113.7, 91.152.40.1", "cf-connecting-ip": "203.0.113.8", "true-client-ip": "203.0.113.9" };
  assert.equal(clientIp(req(sent), true), "91.152.40.1");
  assert.equal(clientIp(req(sent), 1), "91.152.40.1");
  // Cloudflare in front of the host: two proxies, so the client is second from the end.
  assert.equal(clientIp(req({ "x-forwarded-for": "198.51.100.4, 91.152.40.1, 172.68.1.1" }), 2), "91.152.40.1");
  assert.equal(clientIp(req(sent), 0), "10.9.9.9");
  assert.equal(clientIp(req({}), 1), "10.9.9.9");
});
