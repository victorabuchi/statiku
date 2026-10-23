// Runs the website script on Notchlight's own pages in Chrome against a local ingest service, then checks what
// reached the database. The pages come from the notchlight repo's docs folder (the source of notchlight.com) with
// the snippet added the way it will be on the live site. Chrome resolves notchlight.com to this machine, so the
// pages run under their real hostname. Nothing leaves the machine: requests to other hosts are answered locally.
//   npm run e2e [-- --docs ../notchlight/docs --chrome <path to Chrome>]
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import pg from "pg";
import puppeteer, { type Page } from "puppeteer-core";
import { createApp } from "../ingest/server.ts";
import { serveDocs, DEFAULT_DOCS } from "./notchlight-site.ts";
import { createProject } from "./project.ts";
import { report } from "./stats.ts";

const { values } = parseArgs({
  options: {
    docs: { type: "string", default: DEFAULT_DOCS },
    chrome: { type: "string", default: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" },
  },
});
const docs = values.docs!;
const databaseUrl = process.env.DATABASE_URL!;

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
// Addresses in Finland, Germany and the US, sent the way Render's proxy forwards them.
const IPS = { fi: "193.166.3.2", de: "141.30.1.1", us: "8.8.8.8" };

// The test project, emptied each run.
const pool = new pg.Pool({ connectionString: databaseUrl });
const NAME = "Notchlight (browser test)";
let project = (await pool.query("select id, key from projects where name = $1", [NAME])).rows[0];
project ??= await createProject(pool, NAME, ["notchlight.com"], "Europe/Helsinki");
for (const table of ["events", "sessions", "usage_daily"]) await pool.query(`delete from ${table} where project_id = $1`, [project.id]);

const app = await createApp({ databaseUrl, trustProxy: true, geoPath: new URL("../data/country.mmdb", import.meta.url) });
await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const ingest = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

// The snippet as it will be on notchlight.com.
const site = serveDocs(docs, `<script defer data-project="${project.key}" src="${ingest}/s.js"></script>`);
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://notchlight.com:${(site.address() as AddressInfo).port}`;

const browser = await puppeteer.launch({
  executablePath: values.chrome,
  headless: true,
  // Without the automation flag, so navigator.webdriver is false like in a person's browser.
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--host-resolver-rules=MAP notchlight.com 127.0.0.1", "--disable-blink-features=AutomationControlled"],
});

// Requests leaving the machine: the DMG answers as a download, Polar's checkout page as a stub, the rest fail.
const outside: string[] = [];
const pageErrors: string[] = [];
async function open(ua: string, ip: string, width: number, height: number): Promise<Page> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setUserAgent({ userAgent: ua });
  await page.setViewport({ width, height });
  await page.setExtraHTTPHeaders({ "x-forwarded-for": ip });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "notchlight.com" || url.hostname === "127.0.0.1") return void request.continue();
    outside.push(request.url());
    if (url.pathname.endsWith(".dmg")) {
      return void request.respond({ status: 200, contentType: "application/octet-stream", headers: { "content-disposition": 'attachment; filename="Notchlight.dmg"' }, body: "dmg" });
    }
    if (url.hostname === "buy.polar.sh") return void request.respond({ status: 200, contentType: "text/html", body: "<title>Polar checkout (stub)</title>" });
    void request.abort();
  });
  return page;
}
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
// The live site is https, which receives the referrer's origin. These local pages are http, and Chrome drops an https
// referrer on the way to http, so the arrivals here pass it explicitly.
const from = (referer: string) => ({ referer, referrerPolicy: "unsafe-url" });

// 1. From MacNative's listing, on a Mac in Finland: the home page, Try it free, the download page starts the DMG,
//    then Download again.
const fromMacNative = await open(CHROME_MAC, IPS.fi, 1512, 945);
await fromMacNative.goto(`${origin}/?utm_source=macnative&utm_medium=listing&utm_campaign=launch&fbclid=abc123`, from("https://macnative.io/apps/notchlight"));
await settle(500);
await Promise.all([fromMacNative.waitForNavigation(), fromMacNative.click("a.download")]);
await settle();
await fromMacNative.click("#again");
await settle();

// 2. From Hacker News, in Safari in Germany: the home page, then Buy.
const fromHackerNews = await open(SAFARI_MAC, IPS.de, 1280, 800);
await fromHackerNews.goto(`${origin}/`, from("https://news.ycombinator.com/item?id=45678901"));
await settle(500);
await Promise.all([fromHackerNews.waitForNavigation(), fromHackerNews.click("a.buy:not(.bar-buy)")]);
await settle(500);
const checkoutUrl = fromHackerNews.url();

// 3. Typed in on an iPhone in the US: the privacy page, then a single-page navigation.
const typedIn = await open(IPHONE, IPS.us, 390, 844);
await typedIn.goto(`${origin}/privacy/`);
await settle(500);
await typedIn.evaluate(() => history.pushState({}, "", "/terms/"));
await settle();

await browser.close();
await app.writer.flush();

// What reached the database.
const sessions = (await pool.query("select * from sessions where project_id = $1 order by started_at", [project.id])).rows;
const events = (await pool.query("select * from events where project_id = $1 order by ts", [project.id])).rows;
const of = (session: { id: string }) => events.filter((e) => e.session_id === session.id);
const [a, b, c] = sessions;
const checks: [string, boolean, unknown][] = [];
const check = (what: string, ok: boolean, detail: unknown = "") => checks.push([what, ok, detail]);

check("three visits", sessions.length === 3, sessions.length);
if (a) {
  check("MacNative visit: source, campaign, Finland, Chrome on a Mac desktop", a.source === "MacNative" && a.referrer_host === "macnative.io" && a.utm_medium === "listing" && a.utm_campaign === "launch" && a.country === "FI" && a.browser === "Chrome" && a.os === "macOS" && a.device === "Desktop", a);
  check("MacNative visit: home then the download page", of(a).filter((e) => e.name === "pageview").map((e) => e.path).join(" ") === "/ /download/", of(a).map((e) => `${e.name} ${e.path}`));
  const downloads = of(a).filter((e) => e.name === "download");
  check("MacNative visit: the auto-started download and Download again, both credited to MacNative", downloads.length === 2 && downloads.every((e) => e.source === "MacNative" && e.props?.file === "Notchlight.dmg"), downloads.map((e) => e.props));
}
if (b) {
  const checkout = of(b).find((e) => e.name === "checkout");
  const ref = checkout?.props?.ref;
  check("Hacker News visit: source, Germany, Safari", b.source === "Hacker News" && b.referrer_host === "news.ycombinator.com" && b.country === "DE" && b.browser === "Safari", b);
  check("Buy: a checkout event with a reference", typeof ref === "string" && ref.startsWith("stk_"), checkout?.props);
  check("Buy: Polar's checkout opened with the same reference_id", new URL(checkoutUrl).hostname === "buy.polar.sh" && new URL(checkoutUrl).searchParams.get("reference_id") === ref, checkoutUrl);
}
if (c) {
  check("Typed-in visit: Direct, US, iPhone", c.source === "Direct" && c.country === "US" && c.os === "iOS" && c.device === "Mobile", c);
  check("Typed-in visit: the single-page navigation counted", of(c).map((e) => e.path).join(" ") === "/privacy/ /terms/", of(c).map((e) => e.path));
}
check("no JavaScript errors on the pages", pageErrors.length === 0, pageErrors);
const stored = JSON.stringify([sessions, events]);
check("no IP, click ID or user agent stored", !Object.values(IPS).some((ip) => stored.includes(ip)) && !stored.includes("abc123") && !stored.includes("Version/26.1"));

console.log(await report(pool, project.key, 1));
console.log(`Answered locally instead of leaving the machine: ${[...new Set(outside.filter((u) => u.startsWith("http")).map((u) => new URL(u).hostname))].join(", ")}\n`);
for (const [what, ok, detail] of checks) console.log(`${ok ? "✔" : "✖"} ${what}${ok ? "" : `\n    ${JSON.stringify(detail)}`}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nAll ${checks.length} checks passed`);

site.close();
await app.close();
await pool.end();
process.exit(failed ? 1 : 0);
