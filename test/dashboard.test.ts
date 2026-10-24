// The dashboard's API against a real Postgres: accounts, sites, who may see them, and their numbers. Needs
// TEST_DATABASE_URL (createdb statiku_test); the test empties that database first.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { crc32 } from "node:zlib";
import { createHmac, randomBytes } from "node:crypto";
import { verifyWebhook } from "../dashboard/billing.ts";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { checkInstall, fetchIcon, imageType, isPublicAddress, openRequest } from "../dashboard/check.ts";
import { collect } from "../ingest/collect.ts";
import { domainOf } from "../dashboard/server.ts";
import { migrate } from "../db/migrate.ts";
import { createApp } from "../ingest/server.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : !/test/.test(url) ? "TEST_DATABASE_URL must name a test database" : false;
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const CITIES = existsSync(new URL("../data/city.mmdb", import.meta.url)) ? new URL("../data/city.mmdb", import.meta.url) : undefined;

let app: Awaited<ReturnType<typeof createApp>>;
// Stand-ins for Plausible, GitHub and Google (see "imports" below).
let elsewhere: Server;
let elsewhereUrl: string;
const github = { releases: [] as any[] };
// Polar's stand-in keeps the checkouts asked for and knows which customers exist.
const polar = { checkouts: [] as any[], customers: new Set<string>() };
// How the site watcher finds each site when it looks.
const probes: Record<string, { status: number; html: string } | { error: string }> = {};
const POLAR_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
let pool: pg.Pool;
let base: string;
// What the app would have emailed.
const mailbox: { to: string; subject: string; text: string }[] = [];
const mailFor = async (to: string) => {
  for (let i = 0; i < 40 && !mailbox.some((m) => m.to === to); i++) await new Promise((r) => setTimeout(r, 25));
  return mailbox.filter((m) => m.to === to).at(-1);
};

before(async () => {
  if (skip) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("drop schema public cascade; create schema public");
  await admin.end();
  await migrate(url!, () => {});
  pool = new pg.Pool({ connectionString: url });
  elsewhere = createServer(standIn);
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
  // With the city database (npm run geo), live visitors get a city too; the tests check it's never stored.
  app = await createApp({
    databaseUrl: url!, trustProxy: true, geoPath: new URL("../data/country.mmdb", import.meta.url), cityPath: CITIES, flushMs: 60_000,
    // Instead of OpenStreetMap: every shared point is 8 metres from the same house in Kuopio.
    geocode: async () => ({ street: "Särkiniementie", number: "30", numberMetres: 8, area: "Saaristokaupunki", city: "Kuopio", region: "North Savo", country: "FI" }),
    mailer: async (mail) => void mailbox.push(mail),
    imports: {
      request: openRequest, github: elsewhereUrl,
      google: { auth: `${elsewhereUrl}/auth`, token: `${elsewhereUrl}/token`, data: elsewhereUrl, admin: elsewhereUrl, clientId: "id", clientSecret: "secret" },
    },
    probe: async (domain) => probes[domain] ?? { error: "ENOTFOUND" },
    polar: {
      api: elsewhereUrl, token: "polar-token", secret: POLAR_SECRET, request: openRequest,
      products: { "starter:month": "prod-starter-month", "growth:month": "prod-growth-month", "growth:year": "prod-growth-year" },
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  await app.close();
  await pool.end();
  elsewhere.close();
});

// A browser of its own: it keeps its cookie and comes from its own address, so sign-in limits don't overlap.
let browsers = 0;
function browser() {
  const ip = `81.17.${++browsers}.1`;
  let cookie = "";
  const as = async (path: string, { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  };
  return Object.assign(as, { cookie: () => cookie });
}

const PASSWORD = "correct horse battery";
const visit = (key: string, page: string, ip: string, name = "pageview", ua = SAFARI) =>
  fetch(`${base}/e`, {
    method: "POST",
    headers: { "user-agent": ua, "x-forwarded-for": ip },
    body: JSON.stringify({ k: key, n: name, u: page, r: "https://news.ycombinator.com/", w: 1440 }),
  }).then((r) => r.status);

async function signUp(email: string, name = "Victor Abuchi") {
  const as = browser();
  const res = await as("/api/signup", { method: "POST", body: { name, email, password: PASSWORD } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return as;
}

test("sign up, sign out and sign in", { skip }, async () => {
  const as = browser();
  const signup = await as("/api/signup", { method: "POST", body: { name: "Victor", email: " Victor@Example.com ", password: "correct horse battery" } });
  assert.equal(signup.status, 201);
  assert.equal(signup.data.user.email, "victor@example.com");
  const cookie = signup.headers.get("set-cookie")!;
  assert.match(cookie, /^stk_session=[\w-]{40,};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal((await as("/api/me")).data.user.name, "Victor");

  assert.equal((await as("/api/logout", { method: "POST" })).status, 200);
  assert.equal((await as("/api/me")).status, 401);
  const wrong = await as("/api/login", { method: "POST", body: { email: "victor@example.com", password: "nope nope nope" } });
  const nobody = await as("/api/login", { method: "POST", body: { email: "nobody@example.com", password: "nope nope nope" } });
  assert.equal(wrong.status, 401);
  assert.equal(nobody.data.error, wrong.data.error);
  assert.equal((await as("/api/login", { method: "POST", body: { email: "VICTOR@example.com", password: "correct horse battery" } })).status, 200);
  assert.equal((await as("/api/me")).data.user.email, "victor@example.com");

  // Only a hash of the sign-in token is kept, and the password only as scrypt.
  const stored = JSON.stringify((await pool.query("select * from logins")).rows) + JSON.stringify((await pool.query("select * from users")).rows);
  assert.ok(!stored.includes(cookie.split(";")[0].split("=")[1]));
  assert.ok(!stored.includes("correct horse battery"));
});

test("sign-ups are checked, and guessing is slowed down", { skip }, async () => {
  const as = browser();
  assert.equal((await as("/api/signup", { method: "POST", body: { name: "A", email: "victor@example.com", password: "correct horse battery" } })).status, 409);
  assert.equal((await as("/api/signup", { method: "POST", body: { name: "A", email: "not-an-email", password: "correct horse battery" } })).status, 400);
  assert.equal((await as("/api/signup", { method: "POST", body: { name: "A", email: "a@example.com", password: "short" } })).status, 400);
  const guesser = browser();
  const tries = [];
  for (let i = 0; i < 11; i++) tries.push((await guesser("/api/login", { method: "POST", body: { email: "victor@example.com", password: `guess ${i}` } })).status);
  assert.deepEqual(tries.slice(0, 10), Array(10).fill(401));
  assert.equal(tries[10], 429);
});

test("adding a website, and only its own account sees it", { skip }, async () => {
  const owner = await signUp("owner@example.com");
  const added = await owner("/api/sites", { method: "POST", body: { address: "https://www.Example-Shop.com/products?x=1", timezone: "Europe/Helsinki" } });
  assert.equal(added.status, 201);
  const { key, domains, name, timezone } = added.data.site;
  assert.match(key, /^p_[a-z0-9]{10}$/);
  assert.deepEqual(domains, ["example-shop.com"]);
  assert.equal(name, "example-shop.com");
  assert.equal(timezone, "Europe/Helsinki");
  assert.equal((await owner("/api/sites", { method: "POST", body: { address: "not a website" } })).status, 400);

  const listed = await owner("/api/sites");
  assert.deepEqual(listed.data.sites.map((s: any) => s.key), [key]);
  const detail = await owner(`/api/sites/${key}`);
  assert.equal(detail.data.snippet, `<script defer data-project="${key}" src="http://${new URL(base).host}/s.js"></script>`);

  const stranger = await signUp("stranger@example.com");
  assert.deepEqual((await stranger("/api/sites")).data.sites, []);
  for (const [method, path] of [["GET", ""], ["GET", "/stats"], ["GET", "/live"], ["PATCH", ""], ["DELETE", ""]]) {
    const res = await stranger(`/api/sites/${key}${path}`, { method, body: method === "GET" ? undefined : { name: "mine", confirm: "example-shop.com" } });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await browser()(`/api/sites/${key}`)).status, 401);
});

test("visits show in the numbers and the live view, and domain changes apply at once", { skip }, async () => {
  const owner = await signUp("live@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "live-site.com", timezone: "UTC" } })).data.site;
  const visit = (page: string, ip: string) =>
    fetch(`${base}/e`, {
      method: "POST",
      headers: { "user-agent": SAFARI, "x-forwarded-for": ip },
      body: JSON.stringify({ k: key, n: "pageview", u: page, r: "https://news.ycombinator.com/", w: 1440 }),
    }).then((r) => r.status);
  assert.equal(await visit("https://live-site.com/", "193.166.3.2"), 202);
  assert.equal(await visit("https://live-site.com/pricing", "141.30.1.1"), 202);
  await app.writer.flush();

  const stats = (await owner(`/api/sites/${key}/stats?range=today`)).data;
  assert.equal(stats.totals.visitors, 2);
  assert.equal(stats.totals.pageviews, 2);
  assert.deepEqual(stats.sources, [{ label: "Hacker News", v: 2 }]);
  assert.equal(stats.range.unit, "hour");
  assert.ok(stats.series.length >= 1 && stats.previousSeries.length >= 1);
  for (const range of ["yesterday", "d7", "d30", "d90", "m12"]) assert.equal((await owner(`/api/sites/${key}/stats?range=${range}`)).status, 200, range);

  const live = (await owner(`/api/sites/${key}/live`)).data;
  assert.equal(live.visitors, 2);
  assert.deepEqual(live.countries.map((c: any) => c.label).sort(), ["DE", "FI"]);
  assert.equal(live.perMinute.length, 30);
  assert.equal(live.recent.length, 2);
  assert.ok(!JSON.stringify(live).includes("visitor\""), "no visitor hash in the live view");

  // Moved to another domain: the script is accepted there and refused on the old one straight away.
  assert.equal((await owner(`/api/sites/${key}`, { method: "PATCH", body: { domains: ["https://new-site.org"] } })).data.site.domains[0], "new-site.org");
  assert.equal(await visit("https://new-site.org/", "193.166.3.2"), 202);
  assert.equal(await visit("https://live-site.com/", "193.166.3.2"), 403);
});

test("deleting a site needs its domain typed, and takes its data", { skip }, async () => {
  const owner = await signUp("delete@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "gone.example" } })).data.site;
  await fetch(`${base}/e`, { method: "POST", headers: { "user-agent": SAFARI }, body: JSON.stringify({ k: key, n: "pageview", u: "https://gone.example/" }) });
  await app.writer.flush();
  assert.equal((await owner(`/api/sites/${key}`, { method: "DELETE", body: { confirm: "nope.example" } })).status, 400);
  assert.equal((await owner(`/api/sites/${key}`, { method: "DELETE", body: { confirm: "GONE.example" } })).status, 200);
  assert.equal((await owner(`/api/sites/${key}`)).status, 404);
  assert.equal((await pool.query("select count(*)::int as n from events e join projects p on p.id = e.project_id where p.key = $1", [key])).rows[0].n, 0);
});

test("changes only from the app's own pages, and only as JSON", { skip }, async () => {
  const owner = await signUp("csrf@example.com");
  assert.equal((await owner("/api/sites", { method: "POST", body: { address: "a.example" }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await owner("/api/sites", { method: "POST", body: { address: "a.example" }, headers: { origin: "null" } })).status, 403);
  assert.equal((await owner("/api/sites", { method: "POST", body: { address: "a.example" }, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await owner("/api/sites", { method: "POST", body: { address: "a.example" }, headers: { origin: base } })).status, 201);
});

test("the app's pages and files", { skip }, async () => {
  const page = await fetch(`${base}/sites/p_abc/live`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
  const html = await page.text();
  const script = html.match(/src="(\/app\.js\?v=[\w-]+)"/)![1];
  const js = await fetch(base + script, { headers: { "accept-encoding": "gzip" } });
  assert.equal(js.status, 200);
  assert.match(js.headers.get("cache-control")!, /immutable/);
  // Another build's name (two versions answer during a deploy): served, but never kept.
  assert.equal((await fetch(`${base}/app.js?v=someotherbuild`)).headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/api/nothing`)).status, 401);
  // The script and the event endpoint are still the ingest service's.
  assert.equal((await fetch(`${base}/s.js`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("website addresses", () => {
  assert.equal(domainOf("Example.com"), "example.com");
  assert.equal(domainOf("https://www.example.com/shop?x=1#top"), "example.com");
  assert.equal(domainOf("http://blog.example.co.uk:8080/"), "blog.example.co.uk");
  assert.equal(domainOf("münchen.de"), "xn--mnchen-3ya.de");
  for (const bad of ["", "localhost", "example", "https://", "exa mple.com", "192.168.1.1", "-x.com", null]) assert.equal(domainOf(bad), null, String(bad));
});

test("the installation check reaches only public addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "193.166.3.2", "2a00:1450:4001:81a::200e"]) assert.equal(isPublicAddress(ip), true, ip);
  const local = await checkInstall("localhost", "p_whatever");
  assert.equal(local.found, false);
  assert.match(local.message, /public/);
});

test("check-ins keep a visitor live and time the visit; closing the page removes them; neither is an event", { skip }, async () => {
  const owner = await signUp("presence@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "presence.example", timezone: "UTC" } })).data.site;
  const live = async () => (await owner(`/api/sites/${key}/live`)).data;
  // A check-in never starts a visit.
  assert.equal(await visit(key, "https://presence.example/", "193.166.3.9", "_p"), 202);
  assert.equal((await live()).visitors, 0);
  // Arrivals show at once, before anything is written.
  await visit(key, "https://presence.example/", "193.166.3.9");
  await visit(key, "https://presence.example/pricing", "141.30.1.9");
  assert.equal((await live()).visitors, 2);
  assert.deepEqual((await live()).pages.map((p: any) => p.label).sort(), ["/", "/pricing"]);
  // Each with its city, for the globe, when the city database is there.
  if (CITIES) assert.deepEqual((await live()).cities.map((c: any) => c.country).sort(), ["DE", "FI"]);
  // Closing the page: gone at once.
  await visit(key, "https://presence.example/pricing", "141.30.1.9", "_l");
  assert.deepEqual((await live()).countries, [{ label: "FI", v: 1 }]);
  // Two minutes of check-ins later, the visit is two minutes long and still one page view, one event.
  await collect(app.deps, JSON.stringify({ k: key, n: "_p", u: "https://presence.example/" }), SAFARI, "193.166.3.9", new Date(Date.now() + 120_000));
  await app.writer.flush();
  const { rows: [fi] } = await pool.query(
    `select events, pageviews, extract(epoch from last_seen - started_at)::int as seconds from sessions s join projects p on p.id = s.project_id
      where p.key = $1 and s.country = 'FI'`, [key]);
  assert.equal(fi.events, 1);
  assert.equal(fi.pageviews, 1);
  assert.ok(fi.seconds >= 119 && fi.seconds <= 121, String(fi.seconds));
  const { rows: names } = await pool.query("select e.name from events e join projects p on p.id = e.project_id where p.key = $1", [key]);
  assert.deepEqual(names.map((n) => n.name), ["pageview", "pageview"]);
  const { rows: [usage] } = await pool.query("select sum(events)::int as n from usage_daily u join projects p on p.id = u.project_id where p.key = $1", [key]);
  assert.equal(usage.n, 2);
  // The city lives only in memory: no table holds it.
  if (CITIES) {
    const city = (await live()).cities[0].city;
    const { rows: tables } = await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
    for (const { table_name } of tables) assert.ok(!JSON.stringify((await pool.query(`select * from ${table_name}`)).rows).includes(city), `${city} in ${table_name}`);
  }
});

test("the live stream pushes each event the moment it's collected", { skip }, async () => {
  const owner = await signUp("stream@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "stream.example" } })).data.site;
  const res = await fetch(`${base}/api/sites/${key}/stream`, { headers: { cookie: owner.cookie() } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);
  const reader = res.body!.getReader();
  let received = "";
  const arrived = (async () => {
    while (!received.includes('"t":"event"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
  })();
  await visit(key, "https://stream.example/hello", "193.166.3.10");
  await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error("no event in 2 s")), 2000))]);
  await reader.cancel();
  const message = JSON.parse(received.split("\n").find((l) => l.startsWith("data: {"))!.slice(6));
  assert.equal(message.e.name, "pageview");
  assert.equal(message.e.path, "/hello");
  assert.equal(message.e.country, "FI");
  assert.equal((await fetch(`${base}/api/sites/${key}/stream`)).status, 401);
});

test("filters and custom periods", { skip }, async () => {
  const owner = await signUp("filters@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "filters.example", timezone: "UTC" } })).data.site;
  const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:144.0) Gecko/20100101 Firefox/144.0";
  await visit(key, "https://filters.example/", "193.166.3.11");
  await visit(key, "https://filters.example/pricing", "193.166.3.11");
  await visit(key, "https://filters.example/", "141.30.1.11", "pageview", FIREFOX);
  await app.writer.flush();
  const stats = async (q: string) => (await owner(`/api/sites/${key}/stats?${q}`)).data;
  assert.equal((await stats("range=today")).totals.visitors, 2);
  const finland = await stats("range=today&country=FI");
  assert.equal(finland.totals.visitors, 1);
  assert.equal(finland.totals.pageviews, 2);
  assert.deepEqual(finland.countries, [{ label: "FI", v: 1 }]);
  assert.equal((await stats("range=today&browser=Firefox")).totals.visitors, 1);
  assert.equal((await stats("range=today&device=Mobile")).totals.visitors, 0);
  // A page: the visits that viewed it, with all their pages.
  const pricing = await stats("range=today&page=/pricing");
  assert.equal(pricing.totals.visits, 1);
  assert.equal(pricing.totals.pageviews, 2);
  assert.equal((await stats("range=today&country=FI&browser=Firefox")).totals.visitors, 0);
  const today = new Date().toISOString().slice(0, 10);
  const custom = await stats(`range=custom&from=${today}&to=${today}`);
  assert.equal(custom.range.id, "custom");
  assert.equal(custom.range.unit, "hour");
  assert.equal(custom.totals.visitors, 2);
  assert.equal((await stats("range=custom&from=2026-01-01&to=2026-03-31")).range.unit, "day");
  assert.equal((await stats("range=custom&from=nope&to=2026-03-31")).range.id, "d30");
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("your account: name, email, password, photo, and closing it", { skip }, async () => {
  const me = await signUp("me@example.com");
  const renamed = await me("/api/me", { method: "PATCH", body: { name: "Victor A", email: " Me2@Example.com " } });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.data.user.name, renamed.data.user.email], ["Victor A", "me2@example.com"]);
  assert.equal((await me("/api/me", { method: "PATCH", body: { email: "owner@example.com" } })).status, 409);

  // A new password signs out every other browser, not this one.
  const laptop = browser();
  assert.equal((await laptop("/api/login", { method: "POST", body: { email: "me2@example.com", password: PASSWORD } })).status, 200);
  assert.equal((await me("/api/me/password", { method: "POST", body: { current: "wrong password", password: "a new password" } })).status, 401);
  assert.equal((await me("/api/me")).status, 200);
  assert.equal((await me("/api/me/password", { method: "POST", body: { current: PASSWORD, password: "a new password" } })).status, 200);
  assert.equal((await laptop("/api/me")).status, 401);
  assert.equal((await me("/api/me")).status, 200);

  // A photo is checked by its bytes; anything that isn't a PNG, JPEG or WebP is refused.
  const saved = await me("/api/me/photo", { method: "POST", body: { image: `data:image/png;base64,${PNG}` } });
  assert.equal(saved.status, 200);
  assert.equal(typeof saved.data.user.photo, "number");
  const served = await fetch(`${base}/api/me/photo`, { headers: { cookie: me.cookie() } });
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.match(served.headers.get("content-security-policy")!, /sandbox/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
  assert.equal((await me("/api/me/photo", { method: "POST", body: { image: `data:image/png;base64,${svg}` } })).status, 400);
  assert.equal((await me("/api/me/photo", { method: "DELETE" })).data.user.photo, null);

  // Closing the account takes its own sites with it.
  const { key } = (await me("/api/sites", { method: "POST", body: { address: "closing.example" } })).data.site;
  assert.equal((await me("/api/me", { method: "DELETE", body: { password: PASSWORD } })).status, 401);
  assert.equal((await me("/api/me", { method: "DELETE", body: { password: "a new password" } })).status, 200);
  assert.equal((await me("/api/me")).status, 401);
  assert.equal((await pool.query("select count(*)::int as n from projects where key = $1", [key])).rows[0].n, 0);
  assert.equal((await pool.query("select count(*)::int as n from users where email = 'me2@example.com'")).rows[0].n, 0);
});

test("team invitations: a link that works once; members see sites but can't change them", { skip }, async () => {
  const owner = await signUp("teamowner@example.com", "Olivia Owner");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "team-site.example" } })).data.site;
  const { link } = (await owner("/api/team/invites", { method: "POST" })).data;
  const token = link.split("/join/")[1];
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/join\/[\w-]{30,}$/);
  const preview = await browser()(`/api/invites/${token}`);
  assert.deepEqual([preview.data.workspace, preview.data.invitedBy, preview.data.valid], ["Olivia Owner", "Olivia Owner", true]);

  const mia = browser();
  const joined = await mia("/api/signup", { method: "POST", body: { name: "Mia", email: "mia@example.com", password: PASSWORD, invite: token } });
  assert.equal(joined.data.joined, "Olivia Owner");
  const shared = (await mia("/api/sites")).data.sites.find((s: any) => s.key === key);
  assert.equal(shared.role, "member");
  assert.equal((await mia(`/api/sites/${key}/stats?range=today`)).status, 200);
  assert.equal((await mia(`/api/sites/${key}`, { method: "PATCH", body: { name: "Mine" } })).status, 403);
  assert.equal((await mia(`/api/sites/${key}`, { method: "DELETE", body: { confirm: "team-site.example" } })).status, 403);

  // Used once, it's done.
  assert.equal((await browser()(`/api/invites/${token}`)).data.valid, false);
  const late = browser();
  await late("/api/signup", { method: "POST", body: { name: "Late", email: "late@example.com", password: PASSWORD, invite: token } });
  assert.ok(!(await late("/api/sites")).data.sites.some((s: any) => s.key === key));

  const team = (await owner("/api/team")).data;
  assert.deepEqual(team.members.map((m: any) => [m.name, m.role]), [["Olivia Owner", "owner"], ["Mia", "member"]]);
  const miaId = team.members.find((m: any) => m.name === "Mia").id;
  assert.equal((await owner(`/api/team/members/${team.members.find((m: any) => m.you).id}`, { method: "DELETE" })).status, 400);
  assert.equal((await owner(`/api/team/members/${miaId}`, { method: "DELETE" })).status, 200);
  assert.ok(!(await mia("/api/sites")).data.sites.some((s: any) => s.key === key));
});

test("images are known by their bytes, not by what a server says", async () => {
  assert.equal(imageType(Buffer.from(PNG, "base64")), "image/png");
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(imageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(imageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(imageType(Buffer.from([0, 0, 1, 0, 1, 0])), "image/x-icon");
  assert.equal(imageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
  assert.equal(imageType(Buffer.from("<!doctype html><html>")), null);
  assert.equal(await fetchIcon("localhost"), null);
});

test("all time, and a chart by hour, day, week, month or year", { skip }, async () => {
  const owner = await signUp("alltime@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "alltime.example", timezone: "UTC" } })).data.site;
  await visit(key, "https://alltime.example/", "193.166.3.21");
  await app.writer.flush();
  const stats = async (q: string) => (await owner(`/api/sites/${key}/stats?${q}`)).data;
  const all = await stats("range=all");
  assert.equal(all.range.id, "all");
  assert.equal(new Date(all.range.from).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
  assert.equal(all.range.unit, "hour");
  assert.equal(all.totals.visitors, 1);
  assert.deepEqual(all.previousSeries, []);
  assert.equal((await stats("range=d30&by=week")).range.unit, "week");
  assert.equal((await stats("range=m12&by=year")).range.unit, "year");
  // A year by the hour would be thousands of points: the period's own grouping instead.
  assert.equal((await stats("range=m12&by=hour")).range.unit, "month");
  assert.equal((await stats("range=d30&by=fortnight")).range.unit, "day");
});

test("a visitor's city, from the city database", { skip: !CITIES && "run npm run geo for the city database" }, async () => {
  const { Geo } = await import("../ingest/geo.ts");
  const geo = new Geo(new URL("../data/country.mmdb", import.meta.url), CITIES);
  const espoo = geo.place("193.166.3.2");
  assert.equal(geo.country("193.166.3.2"), "FI");
  assert.ok(espoo && espoo.city && Math.abs(espoo.lat - 60.2) < 1 && Math.abs(espoo.lon - 24.7) < 1, JSON.stringify(espoo));
  assert.equal(espoo.region, "Uusimaa");
  assert.ok(!/\(/.test(geo.place("141.30.1.1")?.city ?? ""), "districts are left off");
  assert.equal(new Geo(new URL("../data/country.mmdb", import.meta.url)).place("193.166.3.2"), null);
});

test("exact location: only on sites that ask, only from visitors who share it, never stored", { skip }, async () => {
  const owner = await signUp("location@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "where.example", timezone: "UTC" } })).data.site;
  const config = (ip: string) => fetch(`${base}/v1/site?k=${key}`, { headers: { "user-agent": SAFARI, "x-forwarded-for": ip } });
  const share = (ip: string, name: string, props?: object) =>
    fetch(`${base}/e`, { method: "POST", headers: { "user-agent": SAFARI, "x-forwarded-for": ip }, body: JSON.stringify({ k: key, n: name, u: "https://where.example/", p: props }) });
  const live = async () => (await owner(`/api/sites/${key}/live`)).data;

  // Off: the script isn't told to ask, the answer can be cached, and a shared point is ignored.
  const off = await config("91.152.40.31");
  assert.deepEqual(await off.json(), { ask: false, prompt: false });
  assert.match(off.headers.get("cache-control")!, /max-age/);
  assert.equal(off.headers.get("access-control-allow-origin"), "*");
  await visit(key, "https://where.example/", "91.152.40.31");
  await share("91.152.40.31", "_loc", { lat: 62.8924, lon: 27.6782 });
  assert.deepEqual((await live()).exact, []);

  // On: each visitor is asked once a visit; "not now" holds for the rest of it.
  assert.equal((await owner(`/api/sites/${key}`, { method: "PATCH", body: { askLocation: true } })).data.site.askLocation, true);
  assert.equal((await owner(`/api/sites/${key}`)).data.site.askLocation, true);
  await visit(key, "https://where.example/", "91.152.40.32");
  const asked = await config("91.152.40.32");
  assert.deepEqual(await asked.json(), { ask: true, prompt: true, site: "where.example" });
  assert.equal(asked.headers.get("cache-control"), "no-store");
  await share("91.152.40.32", "_noloc");
  assert.equal((await (await config("91.152.40.32")).json()).prompt, false);

  // Shared: the visitor is at their address, in that street's city, whatever the IP address suggested.
  await visit(key, "https://where.example/", "91.152.40.33");
  await share("91.152.40.33", "_loc", { lat: 62.89237, lon: 27.67821, acc: 12 });
  for (let i = 0; i < 20 && !(await live()).exact[0]?.street; i++) await new Promise((r) => setTimeout(r, 50));
  const now = await live();
  assert.deepEqual(now.exact, [{ lat: 62.8924, lon: 27.6782, acc: 12, city: "Kuopio", country: "FI", street: "Särkiniementie 30", area: "Saaristokaupunki", v: 1 }]);
  const kuopio = now.cities.find((c: any) => c.city === "Kuopio");
  assert.equal(kuopio.exact, 1);
  assert.equal(kuopio.region, "North Savo");
  assert.equal((await (await config("91.152.40.33")).json()).prompt, false);

  // Only as exact as the device was sure: the street with no number at 60 metres, only the neighbourhood at 400.
  await visit(key, "https://where.example/", "91.152.40.34");
  await share("91.152.40.34", "_loc", { lat: 62.8931, lon: 27.6802, acc: 60 });
  await visit(key, "https://where.example/", "91.152.40.35");
  await share("91.152.40.35", "_loc", { lat: 62.8951, lon: 27.6702, acc: 400 });
  const found = (exact: any[]) => exact.length === 3 && exact.every((p) => p.area);
  for (let i = 0; i < 80 && !found((await live()).exact); i++) await new Promise((r) => setTimeout(r, 50));
  const said = Object.fromEntries((await live()).exact.map((p: any) => [p.acc, p.street]));
  assert.deepEqual(said, { 12: "Särkiniementie 30", 60: "Särkiniementie", 400: null });

  // Nothing of it is stored: not the point, not the street, not as an event.
  await app.writer.flush();
  const { rows: tables } = await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
  for (const { table_name } of tables) {
    const dump = JSON.stringify((await pool.query(`select * from ${table_name}`)).rows);
    for (const secret of ["62.89", "27.67", "Särkiniementie", "Saaristokaupunki"]) assert.ok(!dump.includes(secret), `${secret} in ${table_name}`);
  }
  assert.equal((await pool.query("select count(*)::int as n from events where name in ('_loc', '_noloc')")).rows[0].n, 0);
});

test("a forgotten password: a link by email that works once, for that account, and signs out everywhere", { skip }, async () => {
  const owner = await signUp("forgetful@example.com");
  const other = browser();
  assert.equal((await other("/api/login", { method: "POST", body: { email: "forgetful@example.com", password: PASSWORD } })).status, 200);

  // The same answer for an address with no account, and nothing is sent to it.
  const stranger = browser();
  assert.deepEqual((await stranger("/api/password/forgot", { method: "POST", body: { email: "nobody@example.com" } })).data, { ok: true });
  assert.deepEqual((await stranger("/api/password/forgot", { method: "POST", body: { email: "Forgetful@Example.com " } })).data, { ok: true });
  const mail = await mailFor("forgetful@example.com");
  assert.ok(mail, "a reset email");
  assert.equal(mailbox.filter((m) => m.to === "nobody@example.com").length, 0);
  const link = mail!.text.match(/\/reset\/([\w-]+)/)!;
  assert.ok(link);

  // The link says whose account it is, takes a new password, and signs in with it.
  assert.deepEqual((await stranger(`/api/password/reset/${link[1]}`)).data, { valid: true, email: "forgetful@example.com" });
  assert.equal((await stranger(`/api/password/reset/${link[1]}`, { method: "POST", body: { password: "short" } })).status, 400);
  const done = await stranger(`/api/password/reset/${link[1]}`, { method: "POST", body: { password: "a brand new password" } });
  assert.equal(done.status, 200);
  assert.equal(done.data.user.email, "forgetful@example.com");
  assert.equal((await stranger("/api/me")).status, 200);

  // Once only; the old password is gone, and so are the other sign-ins.
  assert.deepEqual((await stranger(`/api/password/reset/${link[1]}`)).data, { valid: false });
  assert.equal((await stranger(`/api/password/reset/${link[1]}`, { method: "POST", body: { password: "another one entirely" } })).status, 410);
  assert.equal((await owner("/api/me")).status, 401);
  assert.equal((await other("/api/me")).status, 401);
  assert.equal((await browser()("/api/login", { method: "POST", body: { email: "forgetful@example.com", password: PASSWORD } })).status, 401);
  assert.equal((await browser()("/api/login", { method: "POST", body: { email: "forgetful@example.com", password: "a brand new password" } })).status, 200);
  assert.equal((await stranger("/api/password/reset/not-a-real-token-at-all-0123")).data.valid, false);
});

// ---------- Imports ----------

// Plausible's Stats API, GitHub's releases and Google's sign-in and Analytics APIs, answering as they document.
function standIn(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/v2/query") {
      if (req.headers.authorization !== "Bearer plausible-key") return send(401, { error: "Invalid API key" });
      const q = JSON.parse(body);
      const by = q.dimensions[1] ?? "total";
      const rows: Record<string, [string, string, number[]][]> = {
        total: [["2025-01-01", "", [10, 12, 30, 50, 60]], ["2025-01-02", "", [20, 25, 50, 40, 120]], ["2025-01-03", "", [5, 5, 8, 100, 0]]],
        "visit:source": [["2025-01-01", "Google", [6, 7, 18]], ["2025-01-01", "Direct / None", [4, 5, 12]], ["2025-01-02", "news.ycombinator.com", [20, 25, 50]]],
        "event:page": [["2025-01-01", "/", [10, 20]], ["2025-01-01", "/pricing", [5, 10]]],
        "visit:entry_page": [["2025-01-01", "/", [12]]],
        "visit:country": [["2025-01-01", "FI", [7]], ["2025-01-01", "US", [3]]],
        "visit:device": [["2025-01-01", "Desktop", [10]]],
        "visit:browser": [["2025-01-01", "Safari", [10]]],
        "visit:os": [["2025-01-01", "Mac", [10]]],
      };
      return send(200, { results: (rows[by] ?? []).map(([d, v, m]) => ({ dimensions: by === "total" ? [d] : [d, v], metrics: m })) });
    }
    if (path === "/v1/checkouts/" || path === "/v1/customer-sessions/") {
      if (req.headers.authorization !== "Bearer polar-token") return send(401, { detail: "Unauthorized" });
      const q = JSON.parse(body);
      if (path === "/v1/checkouts/") {
        polar.checkouts.push(q);
        return send(201, { id: "co_1", url: `https://polar.test/checkout/${polar.checkouts.length}` });
      }
      return polar.customers.has(q.external_customer_id) ? send(201, { customer_portal_url: "https://polar.test/portal" }) : send(404, { detail: "Customer not found" });
    }
    if (path === "/repos/acme/app/releases") return send(200, github.releases);
    if (path === "/repos/acme/missing/releases") return send(404, { message: "Not Found" });
    if (path === "/token") {
      const form = new URLSearchParams(body);
      return form.get("code") === "good" ? send(200, { access_token: "ga-token", expires_in: 3600, refresh_token: "r" }) : send(400, { error: "invalid_grant" });
    }
    if (req.headers.authorization !== "Bearer ga-token") return send(401, { error: { message: "Request had invalid authentication credentials." } });
    if (path === "/v1beta/accountSummaries") {
      return send(200, { accountSummaries: [{ displayName: "Acme", propertySummaries: [{ property: "properties/123", displayName: "acme.com" }] }] });
    }
    if (path === "/v1beta/properties/123:runReport") {
      const q = JSON.parse(body);
      const by = q.dimensions[1]?.name ?? "total";
      const values: Record<string, [string, string[]]> = {
        total: ["", ["8", "10", "20", "0.5", "30"]], sessionSource: ["(direct)", ["8", "9", "20"]], pagePath: ["/docs?x=1", ["8", "20"]],
        landingPage: ["/docs", ["9"]], countryId: ["SE", ["8"]], deviceCategory: ["mobile", ["8"]], browser: ["Chrome", ["8"]], operatingSystem: ["Android", ["8"]],
      };
      const [value, metrics] = values[by];
      return send(200, { rowCount: 1, rows: [{ dimensionValues: [{ value: "20240601" }, ...(by === "total" ? [] : [{ value }])], metricValues: metrics.map((m) => ({ value: m })) }] });
    }
    send(404, { error: "not here" });
  });
}

// A ZIP of the given files, stored as they are.
function zip(files: Record<string, string>) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(entry, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

test("imports: Plausible, Google Analytics, files and GitHub releases, each day counted once", { skip }, async () => {
  const owner = await signUp("history@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "history.example", timezone: "UTC" } })).data.site;
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const list = (await owner(`/api/sites/${key}/imports`)).data.imports;
      if (list.every((x: any) => x.status !== "running")) return list;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("an import never finished");
  };
  const report = async (query: string) => (await owner(`/api/sites/${key}/stats?${query}`)).data;
  const upload = async (files: Record<string, string | Buffer>) => {
    const form = new FormData();
    for (const [name, data] of Object.entries(files)) form.append("file", new Blob([data as BlobPart]), name);
    const res = await fetch(`${base}/api/sites/${key}/imports/file`, { method: "POST", headers: { cookie: owner.cookie(), origin: base }, body: form });
    return { status: res.status, data: await res.json() };
  };

  // Plausible: a wrong key fails with Plausible's reason; the right one brings every breakdown in.
  assert.equal((await owner(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "plausible", host: elsewhereUrl, key: "nope", site: "history.example" } })).status, 202);
  let list = await settled();
  assert.equal(list[0].status, "failed");
  assert.match(list[0].error, /didn't accept that API key/);
  await owner(`/api/sites/${key}/imports/${list[0].id}`, { method: "DELETE" });
  assert.equal((await owner(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "plausible", host: elsewhereUrl, key: "plausible-key", site: "history.example" } })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "done");
  assert.deepEqual([list[0].firstDay, list[0].lastDay], ["2025-01-01", "2025-01-03"]);
  assert.equal((await owner(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "plausible", host: elsewhereUrl, key: "plausible-key", site: "history.example" } })).status, 409);

  let r = await report("range=custom&from=2025-01-01&to=2025-01-03");
  assert.deepEqual({ visitors: r.totals.visitors, visits: r.totals.visits, pageviews: r.totals.pageviews, bounce: r.totals.bounce, duration: r.totals.duration },
    { visitors: 35, visits: 42, pageviews: 88, bounce: 50, duration: 89 });
  assert.deepEqual(r.sources.map((s: any) => [s.label, s.v]), [["Hacker News", 20], ["Google", 6], ["Direct", 4]]);
  assert.deepEqual(r.pages.top.map((p: any) => [p.label, p.v, p.pageviews]), [["/", 10, 20], ["/pricing", 5, 10]]);
  assert.deepEqual(r.pages.entry.map((p: any) => [p.label, p.v]), [["/", 12]]);
  assert.deepEqual(r.countries.map((c: any) => [c.label, c.v]), [["FI", 7], ["US", 3]]);
  assert.deepEqual([r.devices.device[0].label, r.devices.browser[0].label, r.devices.os[0].label], ["Desktop", "Safari", "macOS"]);
  assert.deepEqual(r.series.map((p: any) => p.visitors), [10, 20, 5]);
  assert.equal(r.imported.included, true);
  // Another tool's numbers can't be narrowed by Statiku's filters, so a filtered report leaves them out and says so.
  r = await report("range=custom&from=2025-01-01&to=2025-01-03&country=FI");
  assert.equal(r.totals.visitors, 0);
  assert.deepEqual([r.imported.included, r.imported.narrowed], [false, true]);

  // Google Analytics: sign in, pick the property, and its history joins in. The sign-in lives only in memory.
  const start = await fetch(`${base}/api/sites/${key}/imports/google/start`, { headers: { cookie: owner.cookie() }, redirect: "manual" });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get("location")!);
  assert.equal(auth.origin + auth.pathname, `${elsewhereUrl}/auth`);
  assert.equal(auth.searchParams.get("scope"), "https://www.googleapis.com/auth/analytics.readonly");
  const back = await fetch(`${base}/api/imports/google/callback?code=good&state=${auth.searchParams.get("state")}`, { headers: { cookie: owner.cookie() }, redirect: "manual" });
  const grant = new URL(back.headers.get("location")!, base).searchParams.get("google");
  assert.ok(grant);
  assert.equal((await fetch(`${base}/api/imports/google/callback?code=good&state=${auth.searchParams.get("state")}`, { headers: { cookie: owner.cookie() }, redirect: "manual" })).status, 400);
  assert.deepEqual((await owner(`/api/sites/${key}/imports/google/properties?grant=${grant}`)).data.properties, [{ id: "123", name: "acme.com", account: "Acme" }]);
  assert.equal((await browser()(`/api/sites/${key}/imports/google/properties?grant=${grant}`)).status, 401);
  assert.equal((await owner(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "ga4", grant, property: "123", name: "acme.com" } })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "done");
  r = await report("range=all");
  assert.equal(r.range.from.slice(0, 10), "2024-06-01");
  r = await report("range=custom&from=2024-06-01&to=2024-06-01");
  assert.deepEqual([r.totals.visitors, r.totals.visits, r.totals.pageviews, r.totals.bounce, r.totals.duration], [8, 10, 20, 50, 30]);
  assert.deepEqual([r.sources[0].label, r.pages.top[0].label, r.countries[0].label, r.devices.device[0].label], ["Direct", "/docs", "SE", "Mobile"]);

  // A file: Google Analytics' CSV, a day the other imports don't have and one they do (left out, and the note says so).
  assert.equal((await upload({ "ga.csv": "# Google Analytics\n# Start date: 20240101\n\nDate,Total users,Sessions,Views\n20240301,4,5,9\n20250102,999,999,999\n" })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "done");
  assert.match(list[0].note, /1 day was already covered/);
  assert.equal((await report("range=custom&from=2024-03-01&to=2024-03-01")).totals.pageviews, 9);
  assert.equal((await report("range=custom&from=2025-01-02&to=2025-01-02")).totals.visitors, 20);
  assert.equal((await upload({ "ga.csv": "# Google Analytics\n# Start date: 20240101\n\nDate,Total users,Sessions,Views\n20240301,4,5,9\n20250102,999,999,999\n" })).status, 409);

  // Plausible's own export, zipped: totals and sources go in; exit pages, which Statiku doesn't keep, are skipped.
  const exported = zip({
    "imported_visitors.csv": "date,visitors,pageviews,bounces,visits,visit_duration\n2024-04-01,3,6,1,4,200\n",
    "imported_sources.csv": "date,source,referrer,utm_source,visitors,visits\n2024-04-01,Reddit,reddit.com,,2,3\n2024-04-01,Reddit,old.reddit.com,,1,1\n",
    "imported_exit_pages.csv": "date,exit_page,visitors,exits\n2024-04-01,/bye,3,3\n",
  });
  assert.equal((await upload({ "plausible-export.zip": exported })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "done");
  assert.match(list[0].note, /imported_exit_pages\.csv was skipped/);
  r = await report("range=custom&from=2024-04-01&to=2024-04-01");
  assert.deepEqual([r.totals.visitors, r.totals.bounce, r.totals.duration, r.sources[0].label, r.sources[0].v], [3, 25, 50, "Reddit", 3]);

  // One row per page view (Umami's export): counted up by day, visitor and visit, in the site's time zone.
  assert.equal((await upload({
    "website_event.csv": "created_at,session_id,visit_id,url_path,referrer_domain,country,device,browser,os,event_type\n" +
      "2024-05-01 10:00:00,s1,v1,/a,github.com,DE,laptop,firefox,Linux,1\n2024-05-01 10:01:00,s1,v1,/b,,DE,laptop,firefox,Linux,1\n" +
      "2024-05-01 11:00:00,s2,v2,/a,,FR,mobile,ios,iOS,1\n2024-05-01 11:00:05,s2,v2,/a,,FR,mobile,ios,iOS,2\n",
  })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "done");
  r = await report("range=custom&from=2024-05-01&to=2024-05-01");
  assert.deepEqual([r.totals.visitors, r.totals.visits, r.totals.pageviews], [2, 2, 3]);
  assert.deepEqual(r.pages.entry.map((p: any) => [p.label, p.v]), [["/a", 2]]);
  assert.deepEqual(r.sources.map((s: any) => [s.label, s.v]), [["Direct", 2], ["GitHub", 1]]);
  assert.deepEqual(r.devices.browser.map((b: any) => b.label).sort(), ["Firefox", "Safari"]);
  assert.equal((await upload({ "nothing.csv": "name,colour\nbob,blue\n" })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "failed");

  // Statiku's own first event ends the imported history: from that day on, its own numbers count.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await upload({ "today.csv": `date,visitors\n${today},500\n2023-12-31,1\n` })).status, 202);
  await settled();
  await visit(key, "https://history.example/", "91.152.40.90");
  await app.writer.flush();
  r = await report(`range=custom&from=${today}&to=${today}`);
  assert.equal(r.totals.visitors, 1);
  assert.equal(r.imported.ownFrom, today);
  assert.equal((await report("range=custom&from=2023-12-31&to=2023-12-31")).totals.visitors, 1);

  // GitHub: every release's downloads on the day it came out, then what they gain, day by day.
  github.releases = [
    { id: 1, tag_name: "v1.0", published_at: "2025-01-01T10:00:00Z", created_at: "2025-01-01T09:00:00Z", assets: [{ id: 11, download_count: 100 }] },
    { id: 2, tag_name: "v1.1", published_at: "2025-01-02T22:30:00Z", created_at: "2025-01-02T22:00:00Z", assets: [{ id: 21, download_count: 50 }, { id: 22, download_count: 5 }] },
    { id: 3, tag_name: "v2.0-draft", draft: true, created_at: "2025-02-01T00:00:00Z", assets: [{ id: 31, download_count: 9 }] },
  ];
  assert.equal((await owner(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "github", repo: "acme/missing" } })).status, 202);
  list = await settled();
  assert.match(list[0].error, /no public repository acme\/missing/);
  assert.equal((await owner(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "github", repo: "https://github.com/acme/app" } })).status, 202);
  list = await settled();
  assert.equal(list[0].status, "done");
  r = await report("range=all");
  assert.deepEqual([r.releases.total, r.releases.byRelease], [155, [{ label: "v1.0", v: 100 }, { label: "v1.1", v: 55 }]]);
  github.releases[0].assets[0].download_count = 110;
  github.releases[1].assets[0].download_count = 62;
  await app.jobs!.refreshDownloads();
  r = await report("range=today");
  assert.deepEqual([r.releases.total, r.releases.period], [177, 22]);
  assert.equal(r.series.reduce((n: number, p: any) => n + p.releases, 0), 22);

  // Only the owner imports; deleting an import takes its history out of every report.
  const member = await signUp("history-member@example.com");
  const { link } = (await owner("/api/team/invites", { method: "POST" })).data;
  await member(`/api/invites/${link.split("/join/")[1]}/accept`, { method: "POST" });
  assert.equal((await member(`/api/sites/${key}/imports`)).status, 200);
  assert.equal((await member(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "github", repo: "acme/other" } })).status, 403);
  const plausible = list.find((x: any) => x.label.startsWith("Plausible"));
  await owner(`/api/sites/${key}/imports/${plausible.id}`, { method: "DELETE" });
  assert.equal((await report("range=custom&from=2025-01-01&to=2025-01-03")).totals.visitors, 0);
});

// ---------- Billing ----------

test("Polar's webhook signatures: either kind of secret, never forged, never stale", () => {
  const body = Buffer.from('{"type":"subscription.active"}'), at = String(Math.floor(Date.now() / 1000));
  const signed = (key: Buffer, t = at) => `v1,${createHmac("sha256", key).update(`msg_1.${t}.`).update(body).digest("base64")}`;
  const modern = Buffer.from(POLAR_SECRET.slice(6), "base64"), legacy = Buffer.from(POLAR_SECRET, "utf8");
  assert.ok(verifyWebhook(POLAR_SECRET, { id: "msg_1", timestamp: at, signature: signed(modern) }, body));
  assert.ok(verifyWebhook(POLAR_SECRET, { id: "msg_1", timestamp: at, signature: `v1,bm9wZQ== ${signed(legacy)}` }, body));
  assert.ok(!verifyWebhook(POLAR_SECRET, { id: "msg_2", timestamp: at, signature: signed(modern) }, body));
  assert.ok(!verifyWebhook(POLAR_SECRET, { id: "msg_1", timestamp: at, signature: signed(Buffer.from("another key")) }, body));
  const old = String(Number(at) - 600);
  assert.ok(!verifyWebhook(POLAR_SECRET, { id: "msg_1", timestamp: old, signature: signed(modern, old) }, body));
  assert.ok(!verifyWebhook("", { id: "msg_1", timestamp: at, signature: signed(Buffer.alloc(0)) }, body));
});

test("plans: a trial, a checkout with Polar, its webhook, and reports that close only when nothing's paid", { skip }, async () => {
  const owner = await signUp("paying@example.com");
  const { key } = (await owner("/api/sites", { method: "POST", body: { address: "paying.example", timezone: "UTC" } })).data.site;
  const { rows: [{ workspace_id: workspace }] } = await pool.query("select m.workspace_id from memberships m join users u on u.id = m.user_id where u.email = 'paying@example.com'");

  // A new workspace is in its 30-day trial, with every plan on offer that has a product in Polar.
  let billing = (await owner("/api/billing")).data;
  assert.equal(billing.access, "trial");
  // Thirty days, give or take a daylight saving change.
  assert.ok(Math.abs(new Date(billing.trialEndsAt).getTime() - Date.now() - 30 * 86400_000) <= 3600_000 + 60_000);
  assert.deepEqual(billing.buyable.sort(), ["growth:month", "growth:year", "starter:month"]);
  assert.equal((await owner("/api/me")).data.billing.access, "trial");

  // Choosing a plan: a Polar checkout for this workspace, which comes back to Settings.
  assert.equal((await owner("/api/billing/checkout", { method: "POST", body: { plan: "business", interval: "month" } })).status, 400);
  const checkout = await owner("/api/billing/checkout", { method: "POST", body: { plan: "growth", interval: "year" } });
  assert.match(checkout.data.url, /^https:\/\/polar\.test\/checkout\//);
  assert.deepEqual([polar.checkouts.at(-1).products, polar.checkouts.at(-1).external_customer_id, polar.checkouts.at(-1).customer_email], [["prod-growth-year"], workspace, "paying@example.com"]);
  assert.match(polar.checkouts.at(-1).success_url, /\/plan\?billing=done$/);
  assert.equal((await owner("/api/billing/portal", { method: "POST" })).status, 404);

  // Polar's webhook: anything not signed with the secret is refused; a signed one sets the plan.
  const deliver = (event: object, at = Math.floor(Date.now() / 1000), id = `msg_${Math.random()}`) => {
    const body = JSON.stringify(event);
    const signature = `v1,${createHmac("sha256", Buffer.from(POLAR_SECRET.slice(6), "base64")).update(`${id}.${at}.${body}`).digest("base64")}`;
    return fetch(`${base}/api/polar/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": signature }, body }).then((r) => r.status);
  };
  const subscription = (status: string, extra: object = {}) => ({
    type: `subscription.${status === "active" ? "active" : "updated"}`,
    data: { id: "sub_1", status, product_id: "prod-growth-year", current_period_end: new Date(Date.now() + 365 * 86400_000).toISOString(), cancel_at_period_end: false, customer: { id: "cus_1", external_id: workspace, email: "paying@example.com" }, ...extra },
  });
  const forged = await fetch(`${base}/api/polar/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }, body: JSON.stringify(subscription("active")) });
  assert.equal(forged.status, 401);
  assert.equal((await owner("/api/billing")).data.access, "trial");
  assert.equal(await deliver(subscription("active")), 202);
  billing = (await owner("/api/billing")).data;
  assert.deepEqual([billing.access, billing.plan, billing.planName, billing.limit, billing.status], ["paid", "growth", "Growth", 100_000, "active"]);
  polar.customers.add(workspace);
  assert.equal((await owner("/api/billing/portal", { method: "POST" })).data.url, "https://polar.test/portal");
  // Paying already: another plan is changed in Polar's portal, never bought as a second subscription.
  assert.equal((await owner("/api/billing/checkout", { method: "POST", body: { plan: "starter", interval: "month" } })).status, 409);

  // An older delivery that arrives late changes nothing.
  assert.equal(await deliver(subscription("canceled"), Math.floor(Date.now() / 1000) - 120), 202);
  assert.equal((await owner("/api/billing")).data.status, "active");

  // Cancelled: the time paid for stays open; when it's over and the trial is long gone, the reports close (the site is
  // still counted), for its team too, until a plan is chosen again.
  const member = await signUp("paying-member@example.com");
  const { link } = (await owner("/api/team/invites", { method: "POST" })).data;
  await member(`/api/invites/${link.split("/join/")[1]}/accept`, { method: "POST" });
  await pool.query("update workspaces set trial_ends_at = now() - interval '1 day' where id = $1", [workspace]);
  assert.equal(await deliver(subscription("canceled", { cancel_at_period_end: true, ends_at: new Date(Date.now() + 86400_000).toISOString() })), 202);
  assert.equal((await owner("/api/billing")).data.access, "paid");
  assert.equal((await owner(`/api/sites/${key}/stats`)).status, 200);
  assert.equal(await deliver(subscription("canceled", { ends_at: new Date(Date.now() - 1000).toISOString() })), 202);
  assert.equal((await owner("/api/billing")).data.access, "locked");
  const closed = await owner(`/api/sites/${key}/stats`);
  assert.equal(closed.status, 402);
  assert.match(closed.data.error, /Choose a plan/);
  assert.match((await member(`/api/sites/${key}/live`)).data.error, /Its owner can choose a plan/);
  assert.equal(await visit(key, "https://paying.example/", "91.152.40.70"), 202);
  assert.equal((await owner(`/api/sites/${key}`)).status, 200);

  // A plan given for free is never closed, whatever Polar says later.
  await pool.query("update workspaces set plan = 'comp' where id = $1", [workspace]);
  assert.equal(await deliver(subscription("canceled")), 202);
  assert.equal((await owner("/api/billing")).data.access, "comp");
  assert.equal((await owner(`/api/sites/${key}/stats`)).status, 200);

  // Going over the plan's events only brings a reminder.
  await pool.query("update workspaces set plan = 'starter' where id = $1", [workspace]);
  await pool.query("update workspaces set subscription_status = 'active' where id = $1", [workspace]);
  const { rows: [{ id: siteId }] } = await pool.query("select id from projects where key = $1", [key]);
  await pool.query("insert into usage_daily (project_id, day, events) values ($1, (now() at time zone 'utc')::date, 12000) on conflict (project_id, day) do update set events = 12000", [siteId]);
  billing = (await owner("/api/billing")).data;
  assert.deepEqual([billing.usage, billing.limit, billing.over, billing.access], [12000, 10_000, true, "paid"]);
});

// ---------- Alerts ----------

test("alerts: a site gone quiet (down, its code gone, or just quiet), visits coming back, and a rush", { skip }, async () => {
  const owner = await signUp("watching@example.com");
  const site = async (domain: string) => {
    const { key } = (await owner("/api/sites", { method: "POST", body: { address: domain, timezone: "UTC" } })).data.site;
    const { rows: [{ id }] } = await pool.query("select id from projects where key = $1", [key]);
    return { key, id };
  };
  const now = new Date();
  // Twenty page views in this hour of each of the last four weeks, and nothing in the last hour.
  const usual = async (id: string, extra: Date[] = []) => {
    const at = [...[1, 2, 3, 4].flatMap((w) => Array.from({ length: 20 }, (_, i) => new Date(now.getTime() - w * 7 * 86400_000 - (i + 1) * 120_000))), ...extra];
    await pool.query("select ensure_month_partitions('events', 1, 0)");
    await pool.query(
      `insert into events (project_id, ts, name, path, source) select $1, t, 'pageview', '/', s from unnest($2::timestamptz[], $3::text[]) as x(t, s)`,
      [id, at, at.map((_, i) => (i >= 80 ? "Hacker News" : "Google"))],
    );
  };
  const down = await site("down.example"), gone = await site("gone.example"), quiet = await site("quiet.example"), off = await site("off.example");
  for (const s of [down, gone, quiet, off]) await usual(s.id);
  probes["down.example"] = { status: 503, html: "" };
  probes["gone.example"] = { status: 200, html: "<html>a new theme</html>" };
  probes["quiet.example"] = { status: 200, html: `<script defer data-project="${quiet.key}" src="/s.js"></script>` };
  assert.equal((await owner(`/api/sites/${off.key}`, { method: "PATCH", body: { alertQuiet: false } })).data.site.alertQuiet, false);

  mailbox.length = 0;
  await app.jobs!.watchSites(now);
  const sent = mailbox.filter((m) => m.to === "watching@example.com").map((m) => m.subject).sort();
  assert.deepEqual(sent, ["Statiku's code is missing from gone.example", "down.example looks down", "quiet.example has gone quiet"]);
  assert.match(mailbox.find((m) => m.subject.includes("down.example"))!.text, /answers with an error \(503\)[\s\S]*about 20 page views an hour/);
  // One email an incident, however long it lasts.
  await app.jobs!.watchSites(now);
  assert.equal(mailbox.length, 3);

  // A visit again: one more email, and the alert is closed.
  await pool.query("insert into events (project_id, ts, name, path, source) values ($1, $2, 'pageview', '/', 'Direct')", [down.id, new Date(now.getTime() + 60_000)]);
  await app.jobs!.watchSites(new Date(now.getTime() + 120_000));
  assert.equal(mailbox.at(-1)!.subject, "Visits are back on down.example");
  assert.equal((await pool.query("select alert_kind from projects where id = $1", [down.id])).rows[0].alert_kind, null);

  // A rush: forty page views in ten minutes, most from Hacker News; one email, not one every five minutes.
  const rush = await site("rush.example");
  await usual(rush.id, Array.from({ length: 40 }, (_, i) => new Date(now.getTime() - i * 15_000)));
  mailbox.length = 0;
  await app.jobs!.watchSites(new Date(now.getTime() + 120_000));
  assert.deepEqual(mailbox.map((m) => m.subject), ["rush.example is getting a rush from Hacker News"]);
  assert.match(mailbox[0].text, /40 page views in the last 15 minutes, 100% of them from Hacker News/);
  await app.jobs!.watchSites(new Date(now.getTime() + 420_000));
  assert.equal(mailbox.length, 1);
});

test("the deep health check asks the database", { skip }, async () => {
  const res = await fetch(`${base}/healthz?deep=1`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /database answering/);
});

test("Statiku's own pages: the landing page for anyone not signed in, the app for everyone who is", { skip }, async () => {
  const landing = await fetch(`${base}/`);
  const html = await landing.text();
  assert.match(html, /See who's on your site <em>right now<\/em>/);
  // The prices come from the plans billing sells, and every file the page names is served.
  assert.match(html, /data-month="€19" data-year="€190"/);
  for (const path of html.match(/\/site\/[\w./-]+\?v=[\w-]+/g)!) assert.equal((await fetch(base + path)).status, 200, path);
  const film = await (await fetch(`${base}/site/film/film.json`)).json();
  assert.equal((await fetch(`${base}/site/film/${film.desktop.frames["live-world"]}`)).headers.get("content-type"), "image/webp");
  for (const page of ["/terms", "/privacy", "/dpa"]) assert.equal((await fetch(base + page)).status, 200, page);
  const owner = await signUp("landing@example.com");
  assert.doesNotMatch((await owner("/")).data, /See who's on your site/);
  assert.match((await owner("/")).data, /\/app\.js\?v=/);
});
