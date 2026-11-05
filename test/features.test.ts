// Statiku's newer measures against a real Postgres: numbers sent from anywhere, the match view, momentum, assists,
// player ratings, match reports, heatmaps, injuries, revenue by source and "what changed". Needs TEST_DATABASE_URL
// (createdb statiku_test); the test empties that database first.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { parseNumbers } from "../ingest/numbers.ts";
import { parseNumbersFile } from "../dashboard/numbers.ts";
import { createApp } from "../ingest/server.ts";

// Payment secrets are kept sealed with it.
process.env.SECRET_KEY ??= randomBytes(32).toString("base64");
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
    // Instead of Slack: what would have been posted.
    post: async (to, init) => {
      slack.push({ url: String(to), body: JSON.parse(init?.body ?? "{}") });
      return { status: 200, type: "text/plain", body: Buffer.from("ok") };
    },
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

test("heatmaps and injuries: clicks, scroll depth, page speed, errors and broken pages, never stored as events", { skip }, async () => {
  const { as, key, id } = await siteOf("heat.example");
  const ip = "198.51.100.20";
  assert.equal(await hit(key, ip, "pageview", "https://heat.example/pricing"), 202);
  for (const [x, y, t] of [[0.5, 400, "Start free"], [0.502, 402, "Start free"], [0.2, 1210, "Yearly"], [0.8, 90, ""]] as const) {
    assert.equal(await hit(key, ip, "_c", "https://heat.example/pricing", { p: { x, y, h: 2400, t } }), 202);
  }
  // Out of range, or not a number: ignored.
  await hit(key, ip, "_c", "https://heat.example/pricing", { p: { x: 4, y: 10 } });
  await hit(key, ip, "_l", "https://heat.example/pricing", { p: { d: 80, lcp: 2100, inp: 120, cls: 0.05, ttfb: 300, st: 200 } });
  await hit(key, "198.51.100.21", "_l", "https://heat.example/pricing", { p: { d: 30, lcp: 4800, inp: 600, cls: 0.3, ttfb: 900, st: 200 } });
  await hit(key, "198.51.100.21", "_l", "https://heat.example/pricing", { p: { d: 50, lcp: 2500 } });
  await hit(key, ip, "_l", "https://heat.example/gone", { p: { d: 100, st: 404 } });
  await hit(key, ip, "_d", "https://heat.example/next", { p: { d: 55, path: "/docs" } });
  await hit(key, ip, "_e", "https://heat.example/pricing", { p: { m: "TypeError: plans is undefined", s: "https://heat.example/app.js", l: 12 } });
  await hit(key, "198.51.100.21", "_e", "https://heat.example/pricing", { p: { m: "TypeError: plans is undefined", s: "https://heat.example/app.js", l: 12 } });
  await app.writer.flush();

  const { rows: [stored] } = await pool.query("select count(*)::int as n from events where project_id = $1 and name like '\\_%'", [id]);
  assert.equal(stored.n, 0);
  const map = await as(`/api/sites/${key}/heatmap?range=today`);
  assert.equal(map.status, 200, JSON.stringify(map.data));
  assert.equal(map.data.path, "/pricing");
  assert.equal(map.data.device, "Desktop");
  assert.equal(map.data.clicks.reduce((a: number, c: any) => a + c.n, 0), 4);
  // The two clicks on the button fall in the same cell.
  assert.ok(map.data.clicks.some((c: any) => c.n === 2 && c.x === 0.5 && c.y === 400), JSON.stringify(map.data.clicks));
  assert.deepEqual(map.data.targets, [{ label: "Start free", v: 2 }, { label: "Yearly", v: 1 }]);
  assert.equal(map.data.height, 2400);
  assert.equal(map.data.views, 1);
  // Three visits read the pricing page: to 80%, 30% and 50%.
  assert.deepEqual(map.data.scroll.slice(0, 8).map((s: any) => s.share), [100, 100, 100, 67, 67, 33, 33, 33]);
  assert.equal((await as(`/api/sites/${key}/heatmap?range=today&path=${encodeURIComponent("/docs")}`)).data.scrolled, 1);

  const hurt = (await as(`/api/sites/${key}/insights?range=today`)).data.injuries;
  assert.equal(hurt.vitals.samples, 4);
  assert.ok(hurt.vitals.lcp > 2500 && hurt.vitals.lcp <= 4800, String(hurt.vitals.lcp));
  assert.equal(hurt.slow[0].path, "/pricing");
  assert.deepEqual(hurt.errors.map((e: any) => [e.message, e.n, e.line, e.browsers]), [["TypeError: plans is undefined", 2, 12, ["Safari"]]]);
  assert.deepEqual(hurt.broken, [{ path: "/gone", status: 404, n: 1 }]);
});


test("revenue by source: Stripe and Polar payments, from each site's own webhook, credited to the checkout's visit", { skip }, async () => {
  const { as, key } = await siteOf("shop.example");
  const stripeSecret = `whsec_${randomBytes(16).toString("hex")}`;
  const polarSecret = `whsec_${randomBytes(24).toString("base64")}`;
  assert.equal((await as(`/api/sites/${key}`, { method: "PATCH", body: { stripeSecret, polarSecret } })).status, 200);
  const info = (await as(`/api/sites/${key}`)).data.site.payments;
  assert.equal(info.stripe && info.polar, true);
  assert.match(info.stripeUrl, new RegExp(`/api/pay/stripe/${key}$`));
  // The secret isn't kept as it is.
  const { rows: [kept] } = await pool.query("select stripe_secret from projects where key = $1", [key]);
  assert.ok(kept.stripe_secret && !kept.stripe_secret.includes(stripeSecret));

  // A visitor from Hacker News clicks a Stripe checkout link: the script sent "checkout" with the link's reference.
  assert.equal(await hit(key, "203.0.113.40", "pageview", "https://shop.example/pricing"), 202);
  assert.equal(await hit(key, "203.0.113.40", "checkout", "https://shop.example/pricing", { p: { ref: "stk_abc123" } }), 202);
  await app.writer.flush();

  const stripe = (event: unknown, secret = stripeSecret) => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return fetch(`${base}/api/pay/stripe/${key}`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}`, "content-type": "application/json" }, body })
      .then(async (r) => ({ status: r.status, data: await r.json() }));
  };
  const paid = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", client_reference_id: "stk_abc123", amount_total: 2900, currency: "eur", payment_status: "paid" } } };
  assert.equal((await stripe(paid, "whsec_wrong")).status, 401);
  assert.deepEqual((await stripe(paid)).data, { ok: true, recorded: true, matched: true });
  // Stripe sends again: counted once.
  assert.deepEqual((await stripe(paid)).data, { ok: true, recorded: false, matched: false });
  // Not a payment: nothing changes.
  assert.deepEqual((await stripe({ type: "customer.created", data: { object: { id: "cus_1" } } })).data, { ok: true, payment: false });

  // A Polar order whose reference Statiku never saw.
  const body = JSON.stringify({ type: "order.paid", data: { id: "ord_1", total_amount: 1500, currency: "usd", metadata: { reference_id: "stk_unknown1" } } });
  const id = "msg_1", ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(polarSecret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  const polar = await fetch(`${base}/api/pay/polar/${key}`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body });
  assert.deepEqual(await polar.json(), { ok: true, recorded: true, matched: false });

  const earned = (await as(`/api/sites/${key}/insights?range=today`)).data.revenue;
  assert.deepEqual(earned.totals, [{ currency: "EUR", minor: 2900, sales: 1 }, { currency: "USD", minor: 1500, sales: 1 }]);
  assert.deepEqual(earned.sources.map((r: any) => [r.label, r.currency, r.minor]), [["Hacker News", "EUR", 2900], ["Not matched", "USD", 1500]]);
  assert.deepEqual(earned.landings.map((r: any) => [r.label, r.minor]), [["/pricing", 2900]]);
  // Sales are goals in the match view, with their takings, and so is the checkout click (one of the usual goals).
  const board = (await as(`/api/sites/${key}/match`)).data;
  assert.equal(board.today.goals, 3);
  assert.deepEqual(board.today.takings, [{ currency: "EUR", minor: 2900 }, { currency: "USD", minor: 1500 }]);
  // A site that isn't connected has no webhook.
  const other = await siteOf("plain.example");
  assert.equal((await fetch(`${base}/api/pay/stripe/${other.key}`, { method: "POST", body: "{}" })).status, 404);
});


// A visit at a given time, written as the service would have.
async function visitAt(projectId: string, visitor: number, source: string, at: Date, pages: string[], goal?: [string, number?]) {
  const session = 5_000_000 + Math.floor(Math.random() * 1e9);
  const t = (i: number) => new Date(at.getTime() + i * 60_000);
  await pool.query(
    `insert into sessions (project_id, id, visitor, started_at, last_seen, entry_path, exit_path, pageviews, events, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [projectId, session, visitor, at, t(pages.length + 1), pages[0], pages.at(-1), pages.length, pages.length + (goal ? 1 : 0), source],
  );
  for (const [i, path] of pages.entries()) {
    await pool.query("insert into events (project_id, ts, name, session_id, visitor, path, source) values ($1, $2, 'pageview', $3, $4, $5, $6)", [projectId, t(i), session, visitor, path, source]);
  }
  if (goal) {
    await pool.query("insert into events (project_id, ts, name, session_id, visitor, path, source, revenue_minor, currency) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [projectId, t(pages.length), goal[0], session, visitor, pages.at(-1), source, goal[1] ?? null, goal[1] ? "EUR" : null]);
  }
}

test("the weekly match report: last week against the week before, by email and to Slack, once a week", { skip }, async () => {
  const { as, key, id } = await siteOf("report.example");
  assert.equal((await as(`/api/sites/${key}`, { method: "PATCH", body: { slackWebhook: "https://example.com/hook" } })).status, 400);
  const hook = "https://hooks.slack.com/services/T000/B000/abcdefghijkl";
  assert.equal((await as(`/api/sites/${key}`, { method: "PATCH", body: { slackWebhook: hook } })).status, 200);
  assert.equal((await as(`/api/sites/${key}`)).data.site.slack, true);

  // Monday of this week at 09:00 in Helsinki: the report is due.
  const { rows: [w] } = await pool.query(
    `select (date_trunc('week', now() at time zone 'Europe/Helsinki') + interval '9 hours') at time zone 'Europe/Helsinki' as due,
            (date_trunc('week', now() at time zone 'Europe/Helsinki') - interval '7 days' + interval '12 hours') at time zone 'Europe/Helsinki' as last,
            (date_trunc('week', now() at time zone 'Europe/Helsinki') - interval '14 days' + interval '12 hours') at time zone 'Europe/Helsinki' as before`);
  const day = 86400_000;
  // Last week: four visitors, three sign-ups and a sale, and a page that's seen before the goals.
  await visitAt(id, 1, "Hacker News", new Date(w.last.getTime()), ["/", "/pricing"], ["signup"]);
  await visitAt(id, 2, "Hacker News", new Date(w.last.getTime() + day), ["/", "/pricing"], ["signup"]);
  await visitAt(id, 3, "Google", new Date(w.last.getTime() + 2 * day), ["/pricing"], ["purchase", 4900]);
  await visitAt(id, 4, "Google", new Date(w.last.getTime() + 3 * day), ["/blog"]);
  // The week before: two visitors and one smaller sale.
  await visitAt(id, 1, "Google", new Date(w.before.getTime()), ["/"], ["purchase", 1900]);
  await visitAt(id, 2, "Google", new Date(w.before.getTime() + day), ["/blog"]);

  mailbox.length = 0;
  slack.length = 0;
  const sent = await app.jobs!.sendReports(w.due);
  assert.ok(sent >= 1);
  const mail = mailbox.find((m) => m.subject.startsWith("report.example"));
  assert.ok(mail, JSON.stringify(mailbox.map((m) => m.subject)));
  assert.equal(mail.subject, "report.example: you beat last week 4–0");
  assert.match(mail.text, /Visitors: 4, up 100% on the week before\./);
  assert.match(mail.text, /Goals: 3, up 200% on the week before\./);
  assert.match(mail.text, /Revenue: €49\.00, up 158% on the week before\./);
  assert.match(mail.text, /Top scorer: Hacker News, with 2 goals\./);
  assert.match(mail.text, /Assist of the week: \/pricing, seen before 3 of the goals\./);
  assert.match(mail.text, /Star player: |Injuries: none\./);
  const posted = slack.find((p) => p.url === hook);
  assert.ok(posted);
  assert.match(posted.body.text, /^:soccer: \*report\.example: you beat last week 4–0\*/);
  // Once a week.
  const again = await app.jobs!.sendReports(new Date(w.due.getTime() + 3600_000));
  assert.equal(again, 0);
  // Not due on another day.
  await pool.query("update projects set report_week = null where id = $1", [id]);
  assert.equal(await app.jobs!.sendReports(new Date(w.due.getTime() + day)), 0);

  // "Send me one now", from the settings page.
  const now = await as(`/api/sites/${key}/report`, { method: "POST" });
  assert.equal(now.status, 200, JSON.stringify(now.data));
  assert.match(now.data.heading, /^report\.example: /);
});
