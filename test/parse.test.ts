import assert from "node:assert/strict";
import { test } from "node:test";
import { agentOf, isBot } from "../ingest/agent.ts";
import { parseHit } from "../ingest/collect.ts";
import { cleanDomain, hostAllowed } from "../ingest/projects.ts";
import { hash63 } from "../ingest/salts.ts";
import { sourceOf } from "../ingest/source.ts";

const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const EDGE = CHROME_WIN + " Edg/141.0.0.0";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";

test("browsers, systems and devices", () => {
  assert.deepEqual(agentOf(SAFARI_MAC, 1512), { browser: "Safari", os: "macOS", device: "Desktop" });
  assert.deepEqual(agentOf(CHROME_WIN, 1280), { browser: "Chrome", os: "Windows", device: "Laptop" });
  assert.deepEqual(agentOf(IPHONE, 390), { browser: "Safari", os: "iOS", device: "Mobile" });
  assert.deepEqual(agentOf(EDGE, null), { browser: "Edge", os: "Windows", device: "Desktop" });
  assert.deepEqual(agentOf(FIREFOX_LINUX, 800), { browser: "Firefox", os: "Linux", device: "Tablet" });
  assert.equal(agentOf(IPHONE, null).device, "Mobile");
});

test("bots", () => {
  for (const ua of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "curl/8.7.1", "Mozilla/5.0 HeadlessChrome/141.0", "python-requests/2.32", ""]) {
    assert.ok(isBot(ua), ua);
  }
  for (const ua of [SAFARI_MAC, CHROME_WIN, IPHONE, EDGE, FIREFOX_LINUX]) assert.ok(!isBot(ua), ua);
});

test("sources: tags first, then the referrer, then Direct", () => {
  const page = (q = "") => new URL("https://notchlight.com/" + q);
  assert.equal(sourceOf(page(), null).source, "Direct");
  assert.equal(sourceOf(page(), "https://www.google.fi/").source, "Google");
  assert.equal(sourceOf(page(), "https://news.ycombinator.com/item?id=1").source, "Hacker News");
  assert.equal(sourceOf(page(), "https://t.co/abc").source, "X");
  assert.equal(sourceOf(page(), "https://mail.google.com/").source, "Gmail");
  assert.equal(sourceOf(page(), "https://www.someblog.dev/post").source, "someblog.dev");
  assert.equal(sourceOf(page(), "https://someblog.dev/post").referrerHost, "someblog.dev");
  // Moving inside the site is not a source.
  assert.equal(sourceOf(page(), "https://www.notchlight.com/download/").source, "Direct");
  assert.equal(sourceOf(page(), "https://notchlight.com/download/").referrerHost, null);
  const tagged = sourceOf(page("?utm_source=producthunt&utm_medium=launch&utm_campaign=1.4"), "https://www.producthunt.com/");
  assert.deepEqual(tagged, { source: "Product Hunt", referrerHost: "producthunt.com", utmMedium: "launch", utmCampaign: "1.4", utmContent: null, utmTerm: null });
  assert.equal(sourceOf(page("?ref=macnative"), null).source, "MacNative");
  assert.equal(sourceOf(page("?utm_source=news.ycombinator.com"), null).source, "Hacker News");
  assert.equal(sourceOf(page("?utm_source=Spring%20newsletter"), null).source, "Spring newsletter");
});

test("domains", () => {
  assert.equal(cleanDomain("https://www.Notchlight.com/download"), "notchlight.com");
  assert.ok(hostAllowed(["notchlight.com"], "notchlight.com"));
  assert.ok(hostAllowed(["notchlight.com"], "www.notchlight.com"));
  assert.ok(hostAllowed(["notchlight.com"], "docs.notchlight.com"));
  assert.ok(!hostAllowed(["notchlight.com"], "notnotchlight.com"));
  assert.ok(!hostAllowed(["notchlight.com"], "notchlight.com.evil.dev"));
});

test("the visitor hash changes with the salt and with any part", () => {
  const a = Buffer.alloc(32, 1), b = Buffer.alloc(32, 2);
  const h = hash63(a, "project", "81.17.200.1", SAFARI_MAC);
  assert.match(h, /^\d+$/);
  assert.ok(BigInt(h) < 1n << 63n);
  assert.equal(h, hash63(a, "project", "81.17.200.1", SAFARI_MAC));
  assert.notEqual(h, hash63(b, "project", "81.17.200.1", SAFARI_MAC));
  assert.notEqual(h, hash63(a, "project", "81.17.200.2", SAFARI_MAC));
  assert.notEqual(h, hash63(a, "other", "81.17.200.1", SAFARI_MAC));
});

test("event bodies", () => {
  const hit = parseHit(JSON.stringify({
    k: "p_abc", n: "signup", u: "https://notchlight.com/?utm_source=x", r: "https://t.co/", w: 1440.4,
    p: { plan: "pro", seats: 3, yearly: true, nested: { no: 1 }, "": "x", bad: "a\u0000b" },
    $: { amount: 14.99, currency: "usd" },
  }));
  assert.ok(typeof hit === "object");
  assert.equal(hit.width, 1440);
  assert.deepEqual(hit.props, { plan: "pro", seats: 3, yearly: true, bad: "ab" });
  assert.deepEqual(hit.revenue, { minor: 1499, currency: "USD" });
  const yen = parseHit(JSON.stringify({ k: "p", n: "buy", u: "https://a.com/", $: { amount: 1500, currency: "JPY" } }));
  assert.ok(typeof yen === "object" && yen.revenue?.minor === 1500);
  assert.equal(parseHit("nope"), "body is not JSON");
  assert.equal(parseHit(JSON.stringify({ n: "x", u: "https://a.com" })), "missing project key (k)");
  assert.equal(parseHit(JSON.stringify({ k: "p", n: "x", u: "javascript:alert(1)" })), "page URL (u) must be http or https");
  const noRevenue = parseHit(JSON.stringify({ k: "p", n: "x", u: "https://a.com", $: { amount: -1, currency: "EUR" } }));
  assert.ok(typeof noRevenue === "object" && noRevenue.revenue === null);
});
