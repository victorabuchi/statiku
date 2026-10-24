// The dashboard's API against a real Postgres: accounts, sites, who may see them, and their numbers. Needs
// TEST_DATABASE_URL (createdb statiku_test); the test empties that database first.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { isPublicAddress, checkInstall } from "../dashboard/check.ts";
import { domainOf } from "../dashboard/server.ts";
import { migrate } from "../db/migrate.ts";
import { createApp } from "../ingest/server.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : !/test/.test(url) ? "TEST_DATABASE_URL must name a test database" : false;
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";

let app: Awaited<ReturnType<typeof createApp>>;
let pool: pg.Pool;
let base: string;

before(async () => {
  if (skip) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("drop schema public cascade; create schema public");
  await admin.end();
  await migrate(url!, () => {});
  pool = new pg.Pool({ connectionString: url });
  app = await createApp({ databaseUrl: url!, trustProxy: true, geoPath: new URL("../data/country.mmdb", import.meta.url), flushMs: 60_000 });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  await app.close();
  await pool.end();
});

// A browser of its own: it keeps its cookie and comes from its own address, so sign-in limits don't overlap.
let browsers = 0;
function browser() {
  const ip = `81.17.${++browsers}.1`;
  let cookie = "";
  return async (path: string, { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
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
}

async function signUp(email: string) {
  const as = browser();
  const res = await as("/api/signup", { method: "POST", body: { name: "Victor Abuchi", email, password: "correct horse battery" } });
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
