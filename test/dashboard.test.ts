// The dashboard's API against a real Postgres: accounts, sites, who may see them, and their numbers. Needs
// TEST_DATABASE_URL (createdb statiku_test); the test empties that database first.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { checkInstall, fetchIcon, imageType, isPublicAddress } from "../dashboard/check.ts";
import { collect } from "../ingest/collect.ts";
import { domainOf } from "../dashboard/server.ts";
import { migrate } from "../db/migrate.ts";
import { createApp } from "../ingest/server.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL to run" : !/test/.test(url) ? "TEST_DATABASE_URL must name a test database" : false;
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const CITIES = existsSync(new URL("../data/city.mmdb", import.meta.url)) ? new URL("../data/city.mmdb", import.meta.url) : undefined;

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
  // With the city database (npm run geo), live visitors get a city too; the tests check it's never stored.
  app = await createApp({ databaseUrl: url!, trustProxy: true, geoPath: new URL("../data/country.mmdb", import.meta.url), cityPath: CITIES, flushMs: 60_000 });
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
