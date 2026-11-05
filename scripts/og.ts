// The picture links to Statiku show where they're shared (site/og.png, 1200 by 630): the logo, the line, and a real
// screen from the film. Needs Chrome, and the film's pictures (scripts/shots.ts):
//   node scripts/og.ts
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const CHROME = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"]
  .find((p) => { try { return readdirSync(p.replace(/\/[^/]+$/, "")).length > 0; } catch { return false; } });
if (!CHROME) throw new Error("Chrome wasn't found; set CHROME to its executable.");
const require = createRequire(import.meta.url);
const data = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString("base64")}`;
const font = data(require.resolve("@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2"), "font/woff2");
const logo = data(new URL("../dashboard/client/icon.svg", import.meta.url).pathname, "image/svg+xml");
const screen = data(new URL("../site/film/d-match.webp", import.meta.url).pathname, "image/webp");

const html = `<!doctype html><html><head><style>
@font-face { font-family: B; src: url(${font}) format("woff2"); font-weight: 200 800; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; font-family: B, sans-serif; color: #fff;
  background: radial-gradient(700px 420px at 12% 0%, rgba(41, 196, 107, .28), transparent 70%), radial-gradient(700px 500px at 100% 100%, rgba(47, 179, 235, .22), transparent 70%), #08110f; }
.text { position: absolute; left: 72px; top: 88px; width: 560px; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 34px; font-weight: 800; letter-spacing: -.03em; }
.brand img { width: 52px; height: 52px; border-radius: 12px; }
h1 { margin-top: 54px; font-size: 64px; line-height: 1.02; letter-spacing: -.035em; font-weight: 800; }
h1 em { font-style: normal; color: #5ee69a; }
p { margin-top: 26px; font-size: 26px; line-height: 1.35; color: rgba(255, 255, 255, .72); }
.shot { position: absolute; left: 676px; top: 92px; width: 720px; border-radius: 18px; overflow: hidden; border: 1px solid rgba(255, 255, 255, .16);
  box-shadow: 0 30px 90px rgba(0, 0, 0, .6), 0 0 0 8px rgba(255, 255, 255, .04); }
.shot img { display: block; width: 100%; }
</style></head><body>
<div class="text"><div class="brand"><img src="${logo}" alt="">Statiku</div>
<h1>See who's on your site <em>right now</em>.</h1>
<p>Live analytics for websites, SaaS and apps, from the first visit to the sale.</p></div>
<div class="shot"><img src="${screen}" alt=""></div>
</body></html>`;

const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate("document.fonts.ready");
await page.screenshot({ path: new URL("../site/og.png", import.meta.url).pathname, type: "png" });
await browser.close();
console.log("site/og.png");
