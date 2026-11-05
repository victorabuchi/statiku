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
