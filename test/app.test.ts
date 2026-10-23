// App batches end to end against a real Postgres: installs, their match to a website download, their state and
// versions. Needs TEST_DATABASE_URL (createdb statiku_test); the test empties that database first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { collectApp } from "../ingest/app.ts";
import { collect } from "../ingest/collect.ts";
import { createApp } from "../ingest/server.ts";
import { createProject } from "../scripts/project.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : !/test/.test(url) ? "TEST_DATABASE_URL must name a test database" : false;

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const HOME = "193.166.3.2";

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

// A visit from MacNative that downloads the app.
async function download(ip: string, now = new Date(), source = "macnative") {
  const body = (n: string, u: string) => JSON.stringify({ k: key, n, u, r: "https://macnative.io/apps", w: 1512 });
  await collect(app.deps, body("pageview", `https://notchlight.com/?utm_source=${source}`), SAFARI, ip, now);
  await collect(app.deps, body("download", "https://notchlight.com/download/"), SAFARI, ip, now);
  await app.writer.flush();
}

const batch = (install: string, events: object[], extra: object = {}) => ({
  project: key, install, platform: "macOS", osVersion: "26.1", appVersion: "1.5", build: "6", state: "trial", events, ...extra,
});

function post(body: unknown, ip = HOME) {
  return fetch(`${base}/v1/app`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Statiku-Swift/0.1", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const install = async (id: string) => (await pool.query("select * from installs where id = $1", [id])).rows[0];

test("an install is credited to the visit its download came from", { skip }, async () => {
  await download(HOME);
  const id = randomUUID();
  const res = await post(batch(id, [{ name: "install" }, { name: "active" }]));
  assert.equal(res.status, 202);
  await app.writer.flush();

  const row = await install(id);
  assert.equal(row.source, "MacNative");
  assert.equal(row.utm_medium, null);
  assert.equal(row.platform, "macOS");
  assert.equal(row.app_version, "1.5");
  assert.equal(row.os_version, "26.1");
  assert.equal(row.state, "trial");
  assert.ok(row.trial_at);
  assert.equal(row.licensed_at, null);
  assert.equal(row.country, "FI");
  const visit = (await pool.query("select id from sessions where source = 'MacNative'")).rows[0];
  assert.equal(row.session_id, visit.id);

  const events = (await pool.query("select * from events where install_id = $1 order by name", [id])).rows;
  assert.deepEqual(events.map((e) => e.name), ["active", "install"]);
  // Like a visit's events, an install's carry its source.
  assert.ok(events.every((e) => e.source === "MacNative" && e.os === "macOS" && e.app_version === "1.5" && e.session_id === null));

  // A second Mac on the same network finds the download already taken.
  const other = randomUUID();
  await post(batch(other, [{ name: "install" }]));
  assert.equal((await install(other)).source, null);
});

test("later batches update the version and state, and keep the source", { skip }, async () => {
  await download("85.76.10.20");
  const id = randomUUID();
  await post(batch(id, [{ name: "install" }]), "85.76.10.20");
  // Bought a licence and updated, from another network.
  const res = await post(batch(id, [{ name: "update", props: { from: "1.5" } }, { name: "state", props: { from: "trial", to: "licensed" } }], { appVersion: "1.6", build: "7", state: "licensed" }), "62.78.1.1");
  assert.equal(res.status, 202);
  await app.writer.flush();
  const row = await install(id);
  assert.equal(row.app_version, "1.6");
  assert.equal(row.build, "7");
  assert.equal(row.state, "licensed");
  assert.ok(row.trial_at && row.licensed_at && row.licensed_at >= row.trial_at);
  assert.equal(row.source, "MacNative");
  const update = (await pool.query("select * from events where install_id = $1 and name = 'update'", [id])).rows[0];
  assert.equal(update.source, "MacNative");
  assert.deepEqual(update.props, { from: "1.5" });
});

test("an IPv6 network matches by its /64", { skip }, async () => {
  await download("2001:14ba:a0bd:dd00:1c2b:5f3e:aa01:7c11");
  const id = randomUUID();
  await post(batch(id, [{ name: "install" }]), "2001:14ba:a0bd:dd00::9");
  assert.equal((await install(id)).source, "MacNative");
});

test("a download before midnight matches an install after it, and one from two days ago doesn't", { skip }, async () => {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const ip = "91.152.40.7";
  await download(ip, new Date(midnight.getTime() - 10 * 60_000), "producthunt");
  const late = randomUUID();
  const after = new Date(midnight.getTime() + 20 * 60_000);
  await collectApp(app.deps, JSON.stringify(batch(late, [{ name: "install", at: after.toISOString() }])), ip, after);
  assert.equal((await install(late)).source, "Product Hunt");

  const old = "91.152.40.8";
  await download(old, new Date(Date.now() - 25 * 3600_000));
  const id = randomUUID();
  await post(batch(id, [{ name: "install" }]), old);
  assert.equal((await install(id)).source, null);
});

test("two first batches at once make one install", { skip }, async () => {
  await download("84.249.5.5");
  const id = randomUUID();
  const results = await Promise.all([
    post(batch(id, [{ name: "install" }]), "84.249.5.5"),
    post(batch(id, [{ name: "export", props: { format: "png" } }]), "84.249.5.5"),
  ]);
  assert.deepEqual(results.map((r) => r.status), [202, 202]);
  await app.writer.flush();
  const rows = (await pool.query("select source from installs where id = $1", [id])).rows;
  assert.deepEqual(rows, [{ source: "MacNative" }]);
  assert.equal((await pool.query("select count(*)::int as n from events where install_id = $1", [id])).rows[0].n, 2);
});

test("refuses what doesn't belong", { skip }, async () => {
  const id = randomUUID();
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(batch("not-a-uuid", [{ name: "install" }]))).status, 400);
  assert.equal((await post(batch(id, []))).status, 400);
  assert.equal((await post(batch(id, [{ name: "" }]))).status, 400);
  assert.equal((await post(batch(id, [{ name: "x" }], { state: "pirated" }))).status, 400);
  assert.equal((await post(batch(id, [{ name: "x" }], { project: "p_nope" }))).status, 404);
  assert.equal((await post({ ...batch(id, [{ name: "x" }]), pad: "x".repeat(70_000) })).status, 413);
  assert.equal((await fetch(`${base}/v1/app`)).status, 405);
  // Events older than a week are dropped, and so is an install with nothing newer.
  const res = await post(batch(id, [{ name: "active", at: new Date(Date.now() - 8 * 86400_000).toISOString() }]));
  assert.equal(res.status, 202);
  assert.equal(await install(id), undefined);
});

test("no IP is stored, and marks go after 48 hours", { skip }, async () => {
  await app.writer.flush();
  const { rows: tables } = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  );
  for (const { table_name } of tables) {
    const dump = JSON.stringify((await pool.query(`select * from ${table_name}`)).rows);
    for (const ip of [HOME, "85.76.10.20", "62.78.1.1", "2001:14ba", "10.0.0.1"]) assert.ok(!dump.includes(ip), `${ip} in ${table_name}`);
  }
  await download("37.33.1.1", new Date(Date.now() - 49 * 3600_000));
  const marks = async () => (await pool.query("select ts > now() - interval '48 hours' as recent from download_marks")).rows;
  assert.ok((await marks()).some((m) => !m.recent));
  await app.dropMarks();
  const left = await marks();
  assert.ok(left.length > 0 && left.every((m) => m.recent));
});
