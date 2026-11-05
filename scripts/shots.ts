// The pictures the landing page's film plays (site/film.js): the real dashboard on demo data (scripts/demo.ts), with
// live visitors sent from addresses around the world, photographed scene by scene in its desktop and phone layouts,
// and where each thing the cursor points at sits in each picture. Needs Chrome and a database named *demo*:
//   DATABASE_URL=postgres://localhost/statiku_demo node scripts/shots.ts
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { letter } from "../dashboard/mail.ts";
import { Geo } from "../ingest/geo.ts";
import { createApp } from "../ingest/server.ts";
import { DEMO, demo } from "./demo.ts";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/demo/.test(databaseUrl)) throw new Error("Set DATABASE_URL to a database named *demo*: its data is replaced.");
// Pictures are made in a folder of their own and swapped in at the end, so a run that fails leaves the film there was.
const FILM = new URL("../site/film/", import.meta.url).pathname;
const OUT = new URL("../site/film.new/", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"]
  .find((p) => { try { return readdirSync(p.replace(/\/[^/]+$/, "")).length > 0; } catch { return false; } });
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The tracking code in the pictures shows Statiku's real address, not this run's.
process.env.PUBLIC_URL ??= "https://statiku.victorabuchi.com";
const { siteKey, siteId } = await demo(databaseUrl);
const geoPath = new URL("../data/country.mmdb", import.meta.url), cityPath = new URL("../data/city.mmdb", import.meta.url);
const app = await createApp({
  databaseUrl, trustProxy: true, geoPath, cityPath, flushMs: 300, mailer: async () => {}, probe: async () => ({ status: 200, html: "" }),
  // The visitor who shares their location is in Kuopio's market square.
  geocode: async () => ({ street: "Kuopio Market Square", number: null, numberMetres: null, area: "Multimäki", city: "Kuopio", region: "North Savo", country: "FI" }),
});
await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

// Addresses that the city database places around the world, found by trying random ones.
const geo = new Geo(geoPath, cityPath);
const WANT: Record<string, number> = { US: 9, DE: 4, GB: 3, FI: 4, FR: 2, JP: 2, CA: 2, IN: 2, BR: 1, AU: 1, NL: 2, SE: 1, ES: 1 };
const visitors: { ip: string; country: string }[] = [];
let seed = 11;
// Also the heatmap's clicks: the same picture every run.
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
for (let i = 0; i < 4_000_000 && Object.values(WANT).some((n) => n > 0); i++) {
  const ip = [1 + Math.floor(random() * 222), Math.floor(random() * 256), Math.floor(random() * 256), 1 + Math.floor(random() * 250)].join(".");
  const country = geo.country(ip);
  if (!country || !WANT[country] || !geo.place(ip)?.city) continue;
  WANT[country]--;
  visitors.push({ ip, country });
}
const PAGES = ["/", "/download", "/pricing", "/", "/changelog", "/blog/notch-widgets", "/", "/docs"];
const REFERRERS = ["https://www.google.com/", "", "https://news.ycombinator.com/", "https://www.reddit.com/r/macapps/", "https://www.producthunt.com/", "https://t.co/x"];
const send = (key: string, ip: string, n: string, path = "/", extra: object = {}) =>
  fetch(`${BASE}/e`, { method: "POST", headers: { "user-agent": SAFARI, "x-forwarded-for": ip }, body: JSON.stringify({ k: key, n, u: `https://${DEMO.domain}${path}`, w: 1440, ...extra }) });
async function arrive() {
  for (const [i, v] of visitors.entries()) await send(siteKey, v.ip, "pageview", PAGES[i % PAGES.length], { r: REFERRERS[i % REFERRERS.length] });
  const sharer = visitors.find((v) => v.country === "FI")!;
  await send(siteKey, sharer.ip, "_loc", "/", { p: { lat: 62.8924, lon: 27.6784, acc: 9 } });
  await app.writer.flush();
}
// Check-ins keep the visitors live while the pictures are taken.
const beats = setInterval(() => void Promise.all(visitors.map((v) => send(siteKey, v.ip, "_p"))), 25_000);

// Signed in as the demo account.
const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.1.1.1" }, body: JSON.stringify({ email: DEMO.email, password: DEMO.password }) });
const [cookieName, cookieValue] = login.headers.get("set-cookie")!.split(";")[0].split("=");

const { default: puppeteer } = await import(createRequire(import.meta.url).resolve("puppeteer-core"));
if (!CHROME) throw new Error("Chrome wasn't found; set CHROME to its executable.");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
await page.setCookie({ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" });

// Heatmap clicks where the real page has its links and buttons: the page is opened at each width, and a month of
// clicks is spread over what can be clicked (most on the buttons that buy or download, fewer further down).
async function placeClicks(path: string, width: number, device: string, total: number) {
  const probe = await browser.newPage();
  try {
    await probe.setViewport({ width, height: 900 });
    await probe.goto(`https://${DEMO.domain}${path}#statiku-heatmap`, { waitUntil: "networkidle2", timeout: 30_000 });
    await sleep(800);
    const layout = (await probe.evaluate(`(() => {
      const W = document.documentElement.scrollWidth, H = document.documentElement.scrollHeight;
      const items = [...document.querySelectorAll("a, button")].map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, text: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60) };
      }).filter((i) => i.w > 6 && i.h > 6 && i.y >= 0 && i.y < H);
      return { W, H, items };
    })()`)) as { W: number; H: number; items: { x: number; y: number; w: number; h: number; text: string }[] };
    if (!layout.items.length) return;
    const weight = (i: (typeof layout.items)[number]) => (/buy|download|get |try|start|free/i.test(i.text) ? 30 : i.y < 90 ? 7 : 2.5) * Math.exp((-2.2 * i.y) / layout.H);
    const weights = layout.items.map(weight), sum = weights.reduce((a, b) => a + b, 0);
    const gauss = () => (random() + random() + random() - 1.5) / 1.5;
    const rows: [Date, number, number, string | null][] = [];
    for (let n = 0; n < total; n++) {
      if (random() < 0.08) {
        // Now and then, a click on something that isn't a link: a picture, a heading.
        rows.push([new Date(Date.now() - random() * 30 * 86400_000), random(), Math.round(random() * layout.H * 0.6), null]);
        continue;
      }
      let r = random() * sum, k = 0;
      while ((r -= weights[k]) > 0 && k < weights.length - 1) k++;
      const t = layout.items[k];
      const x = t.x + t.w / 2 + gauss() * t.w * 0.28, y = t.y + t.h / 2 + gauss() * t.h * 0.28;
      rows.push([new Date(Date.now() - random() * 30 * 86400_000), Math.max(0, Math.min(1, x / layout.W)), Math.round(y), /@|\d{5}/.test(t.text) ? null : t.text || null]);
    }
    await app.pool.query(
      `insert into clicks (project_id, ts, path, device, x, y, page_h, target)
       select $1, ts, $2, $3, x, y, $4, target from unnest($5::timestamptz[], $6::real[], $7::int[], $8::text[]) as t(ts, x, y, target)`,
      [siteId, path, device, layout.H, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])],
    );
  } catch (e) {
    console.log(`Heatmap clicks for ${path} at ${width}px: ${(e as Error).message}`);
  } finally {
    await probe.close();
  }
}
await placeClicks("/", 1280, "Laptop", 1400);
await placeClicks("/", 390, "Mobile", 420);
await placeClicks("/pricing", 1280, "Laptop", 380);

// A key for the site's numbers, so one can arrive while its page is being photographed.
const numbersKey = (await (await fetch(`${BASE}/api/sites/${siteKey}/numbers/key`, { method: "POST", headers: { cookie: `${cookieName}=${cookieValue}` } })).json()).key;
const sendNumber = (body: object) => fetch(`${BASE}/v1/number`, { method: "POST", headers: { authorization: `Bearer ${numbersKey}` }, body: JSON.stringify(body) });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
type Rect = { x: number; y: number; w: number; h: number };
const film: Record<string, { size: [number, number]; frames: Record<string, string>; rects: Record<string, Rect> }> = {};
const byText = (sel: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)}))`;

let newSite = "";
async function capture(set: "desktop" | "phone") {
  const phone = set === "phone";
  const [W, H]: [number, number] = phone ? [390, 780] : [1280, 800];
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });
  const D: (typeof film)[string] = (film[set] = { size: [W, H], frames: {}, rects: {} });
  const shot = async (name: string) => {
    const file = `${phone ? "p" : "d"}-${name}.webp`;
    await page.screenshot({ path: `${OUT}${file}`, type: "webp", quality: 82 });
    D.frames[name] = file;
  };
  // Where something is in the picture; left out when it's off screen, and the cursor then stays hidden.
  const rect = async (name: string, expr: string) => {
    const r = (await page.evaluate(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`)) as Rect | null;
    if (r && r.y >= 0 && r.y + r.h / 2 <= H && r.w > 0) D.rects[name] = r;
  };
  const click = (expr: string) => page.evaluate(`(${expr})?.click()`);
  // A page, once what it shows has arrived (a report can take a few seconds on a cold database).
  const READY: [RegExp, string][] = [
    [/^\/$/, ".site-card"], [/\/live$/, "button.bar-row"], [/\/tv$/, ".board"], [/\/heatmaps$/, ".heat-stage"], [/\/numbers$/, ".number-tile"], [/\/import$/, ".import-source"],
    [/\/settings$/, "#alerts"], [/\/setup$/, ".status-card"], [/\/new$/, "#f-address"], [/./, "button.kpi"],
  ];
  const open = async (path: string, settle = 1200) => {
    await page.goto(BASE + path, { waitUntil: "networkidle2" });
    await page.waitForSelector(READY.find(([re]) => re.test(path.split("?")[0]))![1], { timeout: 30_000 });
    await sleep(settle);
  };
  const into = (expr: string, block = "start") => page.evaluate(`(() => { const e = ${expr}; if (!e) return; e.scrollIntoView({ block: ${JSON.stringify(block)} }); window.scrollBy(0, ${block === "start" ? -84 : 0}); })()`).then(() => sleep(500));

  // Live: the world, then a country, a city, and the street of the visitor who shared their location.
  await arrive();
  await open(`/sites/${siteKey}/live`, 3500);
  await rect("liveCount", `document.querySelector(".kpi .value")`);
  await rect("rowFinland", byText("button.bar-row", "Finland"));
  await shot("live-world");
  await click(byText("button.bar-row", "Finland"));
  await sleep(3000);
  await rect("rowKuopio", byText("button.bar-row", "Kuopio"));
  await shot("live-finland");
  await click(byText("button.bar-row", "Kuopio"));
  await sleep(3200);
  await rect("rowShared", byText("button.bar-row", "Kuopio Market Square"));
  await shot("live-kuopio");
  await click(byText("button.bar-row", "Kuopio Market Square"));
  await sleep(6000);
  await shot("live-street");

  // The match view: today's scoreboard, then a sale landing as a goal.
  await open(`/sites/${siteKey}/tv`, 2500);
  await rect("matchNow", `document.querySelector(".board .stat.now b")`);
  await rect("matchGoals", `document.querySelectorAll(".board .stat b")[2]`);
  await rect("shareButton", byText(".match-top button", "Share"));
  await rect("commentary", `document.querySelector(".feed li")`);
  await shot("match");
  const buyer = visitors[phone ? 7 : 5];
  await send(siteKey, buyer.ip, "pageview", "/pricing", { r: "https://www.producthunt.com/" });
  await send(siteKey, buyer.ip, "purchase", "/pricing", { $: { amount: 49, currency: "EUR" } });
  await page.waitForSelector(".goal-overlay:not([hidden])", { timeout: 10_000 });
  await sleep(900);
  await shot("match-goal");
  await sleep(4000);
  // On the pitch: everyone on the page they're on, some heading to pricing, and a click on Buy.
  await into(`document.querySelector(".pitch-panel")`);
  await sleep(800);
  await rect("pitchZone", `document.querySelector(".pitch-zone")`);
  await shot("pitch-1");
  for (const v of visitors.slice(0, 7)) await send(siteKey, v.ip, "pageview", "/pricing");
  await sleep(1800);
  await rect("pitchMoved", `[...document.querySelectorAll(".pitch-zone")].find((z) => z.textContent.startsWith("/pricing"))`);
  await shot("pitch-2");
  for (const v of visitors.slice(0, 2)) await send(siteKey, v.ip, "_c", "/pricing", { p: { x: 0.45, y: 520, h: 3000, t: "Buy for $14.99" } });
  await sleep(450);
  await rect("kickLabel", `document.querySelector(".kick em")`);
  await shot("pitch-3");

  // Analytics: the last 30 days, the period menu, 90 days, and only the visits Hacker News sent.
  await open(`/sites/${siteKey}?range=d30`);
  await rect("rangeButton", `document.querySelector('.page button[aria-haspopup="menu"]')`);
  await rect("kpiVisitors", `document.querySelector("button.kpi")`);
  await shot("an-30");
  await click(`document.querySelector('.page button[aria-haspopup="menu"]')`);
  await sleep(500);
  await rect("item90", byText(".popover .item", "Last 90 days"));
  await shot("an-range");
  await open(`/sites/${siteKey}?range=d90`);
  await rect("sourceHN", byText("button.bar-row", "Hacker News"));
  await shot("an-90");
  await open(`/sites/${siteKey}?range=d90&source=Hacker%20News`);
  await rect("chip", `document.querySelector(".filters .chip")`);
  await shot("an-hn");

  // How each page played: assists and ratings, injuries, and what changed, asked in plain words.
  await open(`/sites/${siteKey}?range=d30`);
  await page.waitForSelector(".motm", { timeout: 30_000 });
  await into(byText(".card-head h2", "Assists"));
  await rect("motm", `document.querySelector(".motm")`);
  await rect("topAssist", `document.querySelector(".bars .bar-row")`);
  await shot("ratings");
  await into(byText(".card-head h2", "Injuries"));
  await rect("vital", `document.querySelectorAll(".vital")[1]`);
  await rect("slowPage", `document.querySelector(".grade.poor")`);
  await shot("injuries");
  await into(byText(".card-head h2", "Ask your data"));
  await rect("askButton", byText(".ask-row button", "What changed?"));
  await click(byText(".ask-row button", "What changed?"));
  await page.waitForSelector(".changes li", { timeout: 15_000 });
  await sleep(400);
  await into(byText(".card-head h2", "Ask your data"));
  await rect("changes", `document.querySelector(".changes")`);
  await shot("ask");
  await into(byText(".card-head h2", "Revenue"));
  await rect("callout", `document.querySelector(".callout")`);
  await shot("revenue");

  // Heatmaps: the heat over the real page, then further down it (scrolled inside the page), where fewer read. At
  // twice the pixels headless Chrome draws a scaled frame of another site at half its size, so these two are at one.
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await open(`/sites/${siteKey}/heatmaps`, 6000);
  await page.waitForFunction(`(() => { const l = document.querySelector(".heat-page"); return l && !document.querySelector(".heat-stage.blank"); })()`, { timeout: 15_000 }).catch(() => {});
  await rect("topClick", `document.querySelector(".bars .bar-row")`);
  await rect("heatToggle", `document.querySelector(".heat-grid .check")`);
  await shot("heat");
  const inside = page.frames().find((f: { url(): string }) => f.url().includes(DEMO.domain));
  if (inside) await inside.evaluate(`window.scrollTo(0, ${phone ? 1500 : 1300})`);
  await sleep(1500);
  await rect("scrollMark", `[...document.querySelectorAll(".scroll-mark span")].find((m) => { const r = m.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight; })`);
  await shot("heat-read");
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });

  // Numbers, on the Websites page: the tiles, one arriving live, and (on the site's own page) how to send one.
  await open("/", 1000);
  await page.waitForSelector(".home-numbers .number-tile", { timeout: 20_000 });
  await into(`document.querySelector(".home-numbers")`);
  await rect("tileWidgets", byText(".home-numbers .number-tile", "Widgets added"));
  await shot("numbers");
  await sendNumber({ name: "Widgets added", value: 24, op: "add" });
  await sleep(450);
  await shot("numbers-live");
  await open(`/sites/${siteKey}/numbers`, 1500);
  await into(byText(".card-head h2", "Send a number"));
  await rect("copyCurl", `document.querySelector(".code-block .copy")`);
  await shot("numbers-send");

  // From the visit to the sale, by source.
  await open(`/sites/${siteKey}?range=d90`);
  await into(byText(".card-head h2", "Conversions by source"));
  await rect("convHN", byText("tr.pick", "Hacker News"));
  await rect("funnel", byText(".card-head h2", "Conversion"));
  await shot("conv");
  await into(byText(".page-head h1", "App"), "start");
  await rect("installs", `document.querySelectorAll("button.kpi")[4]`);
  await shot("app");

  // History from before: the Import page, and All time reaching back through it.
  await open(`/sites/${siteKey}/import`);
  await rect("googleButton", byText("a.btn", "Connect Google Analytics"));
  await rect("drop", `document.querySelector(".drop")`);
  await shot("import");
  await open(`/sites/${siteKey}?range=all`);
  await rect("historyNote", `document.querySelector(".history-note")`);
  await shot("an-all");

  // Adding a website: its address, the steps for WordPress, and the first visit turning it green.
  await open("/sites/new");
  await page.evaluate(`(() => { const a = document.querySelector("#f-address"); a.focus(); a.value = "victorabuchi.com"; a.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(300);
  await rect("addButton", byText("button", "Add website"));
  await shot("add");
  {
    // A new site for each layout, so each one starts waiting for its first visit.
    const made = await fetch(`${BASE}/api/sites`, { method: "POST", headers: { cookie: `${cookieName}=${cookieValue}`, "content-type": "application/json" }, body: JSON.stringify({ address: "victorabuchi.com", timezone: "Europe/Helsinki" }) });
    newSite = (await made.json()).site.key;
  }
  await open(`/sites/${newSite}/setup`, 1500);
  await click(byText(".platforms button", "WordPress"));
  await sleep(400);
  await rect("wordpress", byText(".platforms button", "WordPress"));
  await rect("status", `document.querySelector(".status-card")`);
  await shot("setup-wait");
  await fetch(`${BASE}/e`, { method: "POST", headers: { "user-agent": SAFARI, "x-forwarded-for": visitors[0].ip }, body: JSON.stringify({ k: newSite, n: "pageview", u: "https://victorabuchi.com/", w: 1440 }) });
  await sleep(2500);
  await shot("setup-ok");
  // Gone again, so the next layout can add it afresh (an address can't be in an account twice).
  await fetch(`${BASE}/api/sites/${newSite}`, { method: "DELETE", headers: { cookie: `${cookieName}=${cookieValue}`, "content-type": "application/json" }, body: JSON.stringify({ confirm: "victorabuchi.com" }) });

  // Alerts: the site's settings, and the email a rush brings.
  await open(`/sites/${siteKey}/settings`);
  await into(`document.querySelector("#alerts")`, phone ? "start" : "center");
  await rect("surge", `document.querySelector('label[for="s-surge"]')`);
  await shot("alerts");
  const mail = letter({
    heading: `A rush on ${DEMO.domain}`,
    lines: [`212 page views in the last 15 minutes, 71% of them from Hacker News, about 9 times the usual.`, "Someone may have just linked to you. It's a good moment to answer comments and questions."],
    button: { label: "Watch it live", url: `${BASE}/sites/${siteKey}/live` },
    foot: "At most one of these every six hours. Turn them off in the site's settings.",
  });
  await page.setContent(mail.html, { waitUntil: "load" });
  await rect("mailButton", byText("a", "Watch it live"));
  await shot("email");
  // And the weekly match report, each Monday.
  const report = letter({
    heading: `${DEMO.domain}: a better week, 3 of 4 up`,
    lines: [
      "Visitors: 2,184, up 12% on the week before.", "Visits: 2,611, up 9% on the week before.", "Conversions: 318, down 4% on the week before.",
      "Revenue: €1,486.00, up 21% on the week before.", "Top page: /pricing, scored 8.4 out of 10.", "Top source: Google, with 96 conversions.",
      "The page that helped most: /, seen before 204 of the conversions.", "Problems: 46 script errors, most often \"TypeError: Cannot read properties of undefined (reading 'version')\".",
    ],
    button: { label: "Open last week's report", url: `${BASE}/sites/${siteKey}` },
    foot: "The weekly report. Turn it off in the site's settings.",
  });
  await page.setContent(report.html, { waitUntil: "load" });
  await rect("reportButton", byText("a", "Open last week's report"));
  await shot("report");
}

await capture("desktop");
await capture("phone");
writeFileSync(`${OUT}film.json`, JSON.stringify(film, null, 1));
rmSync(FILM, { recursive: true, force: true });
renameSync(OUT, FILM);
clearInterval(beats);
await browser.close();
await app.close();
console.log(`${Object.keys(film.desktop.frames).length + Object.keys(film.phone.frames).length} pictures in site/film.${errors.length ? `\nPage errors:\n${errors.join("\n")}` : ""}`);
