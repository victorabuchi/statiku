// The dashboard, served by the same service as the script: accounts, teams, the sites a person tracks, and their
// numbers. The pages are one app (client/), bundled when the service starts; everything it shows comes from /api.
// Statiku's own pages (site/) are served here too: the landing page at / for anyone not signed in, and the legal pages.
//   GET    /  /login  /signup  /join/…  /settings  /sites/…    the app
//   GET    /  /pricing  /terms  /privacy  /dpa  /site/…        Statiku's own pages (/ only when not signed in)
//   POST   /api/signup  /api/login  /api/logout
//   POST   /api/password/forgot { email }    GET /api/password/reset/:token   POST { password }
//   GET    /api/me              PATCH { name?, email? }   DELETE { password }
//   POST   /api/me/password     { current, password }
//   GET    /api/me/photo        POST { image: data URL }   DELETE
//   GET    /api/team            POST /api/team/invites   DELETE /api/team/invites/:id   DELETE /api/team/members/:id
//   GET    /api/invites/:token  POST /api/invites/:token/accept
//   GET    /api/sites           every site with today's numbers     POST { address, name?, timezone? }
//   GET    /api/sites/:key      PATCH { name?, domains?, timezone? }   DELETE { confirm: domain }
//   GET    /api/sites/:key/icon    the site's own icon
//   POST   /api/sites/:key/check   is the tracking code on the site?
//   GET    /api/sites/:key/stats?range=&from=&to=&by=&source=&country=&device=&browser=&os=&page=
//   GET    /api/sites/:key/live    who's on it right now        GET /api/sites/:key/stream   the same, pushed
//   GET    /api/sites/:key/imports   POST { kind: ga4 | plausible | github, … }   POST …/imports/file (form data)
//   DELETE /api/sites/:key/imports/:id   GET …/imports/google/start → Google → /api/imports/google/callback
//   GET    /api/sites/:key/imports/google/properties?grant=
//   GET    /api/sites/:key/numbers?range=   POST …/numbers/key (a new key)   POST …/numbers/upload (CSV)   DELETE …/numbers/:name
//   GET    /api/sites/:key/match   the match view's scoreboard   POST|DELETE …/match/link   its public link
//   GET    /api/match/:token   GET /api/match/:token/stream   the match view at its public link, and its live feed
//   GET    /api/sites/:key/momentum   who's attacking right now
//   GET    /api/sites/:key/insights?range=   assists, player ratings, injuries and revenue by source for a period
//   POST   /api/pay/stripe/:key   POST /api/pay/polar/:key   a site's payments, from its own Stripe or Polar webhook
//   GET    /api/sites/:key/heatmap?range=&path=&device=   where a page's visitors click, and how far down they read
//   GET    /api/billing   POST /api/billing/checkout { plan, interval }   POST /api/billing/portal   POST /api/polar/webhook
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import * as icons from "simple-icons";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import type pg from "pg";
import type { Hub } from "../ingest/live.ts";
import type { Streets } from "../ingest/streets.ts";
import { cleanDomain } from "../ingest/projects.ts";
import { createProject, deleteProject } from "../scripts/project.ts";
import {
  Attempts, changePassword, clearedCookie, cleanEmail, createUser, deleteAccount, emailLooksRight, endLogin,
  findByPassword, finishReset, loginCookie, resetFor, startLogin, startReset, userOf, type User,
} from "./auth.ts";
import type { Billing } from "./billing.ts";
import { letter, smtpMailer, type Mailer } from "./mail.ts";
import { createMonitor, type Probe } from "./monitor.ts";
import { OWNER, ownerSetup } from "./owner.ts";
import { cleanGoals, goalsOf, matchSummary, shareMatch, siteByMatchToken, stopSharingMatch } from "./match.ts";
import { assists, heatmap, injuries, momentum, ratings, revenue } from "./insights.ts";
import { paymentOf, payingSite, recordPayment, verifyPayment, type Provider } from "./payments.ts";
import { deleteNumber, numbersReport, parseNumbersFile, renewNumbersKey, saveNumbers } from "./numbers.ts";
import { access, applySubscription, BILLING_COLUMNS, checkoutUrl, planOf, PLANS, polarFromEnv, portalUrl, usage, verifyWebhook, type Polar } from "./billing.ts";
import { checkInstall, fetchIcon, imageType, openRequest, publicRequest, type Outbound } from "./check.ts";
import {
  addDownloadsSince, countsOf, GOOGLE, githubReleases, IMPORT_COLUMNS, importFiles, importGithub, importGoogle, importPlausible,
  repoOf, Sink, startImport, googleProperties, type Google,
} from "./imports.ts";
import { canSeal, seal, unseal } from "./secrets.ts";
import { bounds, FILTERS, live, overview, RANGE_IDS, siteFor, stats, type Filters, type Presence, type Site } from "./stats.ts";

export type Request = { req: IncomingMessage; res: ServerResponse; path: string; ip: string; secure: boolean };

const MAX_SITES = 50;
// How long an icon is trusted before the site is looked at again: a day, or half an hour while it has none.
const ICON_FRESH = { found: 86400_000, missing: 30 * 60_000 };
const INVITE_DAYS = 7;
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};
// Images that came from elsewhere (a site's icon may be SVG) can't run anything, even opened on their own.
const IMAGE_HEADERS = { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "x-content-type-options": "nosniff" };

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "");
const hashToken = (token: string) => createHash("sha256").update(token).digest();

// A website address as a person types it ("https://www.Example.com/shop") to the hostname tracked ("example.com").
export function domainOf(address: unknown): string | null {
  const raw = text(address, 300);
  if (!raw) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    const domain = cleanDomain(host);
    return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(domain) ? domain : null;
  } catch {
    return null;
  }
}

const zoneOf = (zone: unknown) => {
  const name = text(zone, 64);
  try {
    if (name) return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
  } catch {}
  return "UTC";
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function image(res: ServerResponse, type: string, data: Buffer) {
  res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=604800", ...IMAGE_HEADERS });
  res.end(data);
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) reject(new HttpError(413, "That's too large."));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readJson(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return Promise.reject(new HttpError(415, "Send JSON."));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) reject(new HttpError(413, "That's too large."));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(body && typeof body === "object" ? body : {});
      } catch {
        reject(new HttpError(400, "That isn't JSON."));
      }
    });
    req.on("error", reject);
  });
}

// The app's script and styles, built once: names hashed from their content and the deploy's commit, so browsers keep
// them until the next deploy and every deploy gives them new names.
async function bundle() {
  const dir = new URL("client/", import.meta.url);
  const { outputFiles } = await build({
    entryPoints: [new URL("main.js", dir).pathname],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    write: false,
    legalComments: "none",
  });
  const asset = (body: string | Uint8Array, type: string) => {
    const data = Buffer.from(body);
    const hash = createHash("sha256").update(data).update(process.env.GIT_COMMIT ?? process.env.RENDER_GIT_COMMIT ?? "").digest("base64url").slice(0, 12);
    return { data, gzip: gzipSync(data), type, hash };
  };
  const require = createRequire(import.meta.url);
  const js = asset(outputFiles[0].contents, "text/javascript; charset=utf-8");
  // The app's typeface, served from here rather than from a font service, so no one else learns who opens the
  // dashboard: Latin, and the rest of Europe's letters for the pages that need them.
  const font = (set: string) => asset(readFileSync(require.resolve(`@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-${set}-standard-normal.woff2`)), "font/woff2");
  const fonts = { "/fonts/latin.woff2": font("latin"), "/fonts/latin-ext.woff2": font("latin-ext") };
  let styles = readFileSync(new URL("app.css", dir), "utf8");
  for (const [path, file] of Object.entries(fonts)) styles = styles.replace(`url("${path}")`, `url("${path}?v=${file.hash}")`);
  const css = asset(styles, "text/css; charset=utf-8");
  const icon = asset(readFileSync(new URL("icon.svg", dir)), "image/svg+xml");
  // The detailed map the globe switches to when zoomed in, loaded only then.
  const map = asset(readFileSync(require.resolve("world-atlas/countries-50m.json")), "application/json");
  const html = asset(
    readFileSync(new URL("index.html", dir), "utf8")
      .replace("/app.js", `/app.js?v=${js.hash}`).replace("/app.css", `/app.css?v=${css.hash}`).replace("/fonts/latin.woff2", `/fonts/latin.woff2?v=${fonts["/fonts/latin.woff2"].hash}`)
      .replaceAll('"/favicon.svg"', `"/favicon.svg?v=${icon.hash}"`),
    "text/html; charset=utf-8",
  );
  return { js, css, icon, html, map, fonts, site: siteBundle(asset, fonts, icon.hash) };
}

// Statiku's own pages, filled in once: the files' versions, the website builders' and tools' logos, and the plans'
// prices from billing.ts, so the landing page never disagrees with Settings.
type Asset = { data: Buffer; gzip: Buffer; type: string; hash: string };
function siteBundle(asset: (body: string | Uint8Array, type: string) => Asset, fonts: Record<string, { hash: string }>, iconHash: string) {
  const dir = new URL("../site/", import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
  let styles = read("site.css");
  for (const [path, file] of Object.entries(fonts)) styles = styles.replace(`url("${path}")`, `url("${path}?v=${file.hash}")`);
  const files: Record<string, Asset> = {
    "/site/site.css": asset(styles, "text/css; charset=utf-8"),
    "/site/site.js": asset(read("site.js"), "text/javascript; charset=utf-8"),
    "/site/film.js": asset(read("film.js"), "text/javascript; charset=utf-8"),
    "/site/film-scenes.js": asset(read("film-scenes.js"), "text/javascript; charset=utf-8"),
  };
  // The film's pictures share film.json's version, so a new set of pictures gets new addresses.
  const filmDir = new URL("film/", dir);
  // Without its pictures (scripts/shots.ts makes them) the film is empty, and everything else still works.
  const filmData = asset(existsSync(new URL("film.json", filmDir)) ? readFileSync(new URL("film.json", filmDir)) : "{}", "application/json");
  files["/site/film/film.json"] = filmData;
  for (const name of existsSync(filmDir) ? readdirSync(filmDir).filter((n) => n.endsWith(".webp")) : []) {
    files[`/site/film/${name}`] = { ...asset(readFileSync(new URL(name, filmDir)), "image/webp"), hash: filmData.hash };
  }
  const logo = (i: { title: string; hex: string; path: string }, size = 20) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#${i.hex}" aria-hidden="true"><path d="${i.path}"/></svg>`;
  const builders = [icons.siWordpress, icons.siShopify, icons.siWix, icons.siSquarespace, icons.siWebflow, icons.siFramer, icons.siGoogletagmanager]
    .map((i) => `<span>${logo(i)}${i.title}</span>`).join("");
  const sources = [icons.siGoogleanalytics, icons.siPlausibleanalytics, icons.siGithub, icons.siFathom, icons.siMatomo, icons.siUmami]
    .map((i) => `<div class="src">${logo(i.hex === "181717" ? { ...i, hex: "ffffff" } : i, 22)}${i.title === "Plausible Analytics" ? "Plausible" : i.title}</div>`).join("")
    + `<div class="into"><img src="/favicon.svg" alt="" width="26" height="26">Your reports, back to day one</div>`;
  const plans = PLANS.map((p, i) => `<article class="plan${i === 1 ? " pick" : ""}">${i === 1 ? '<span class="tag">Most chosen</span>' : ""}<h3>${p.name}</h3>
    <div class="price" data-month="€${p.month}" data-year="€${p.year}"><b>€${p.month}</b><span>a month</span></div>
    <span class="events">Up to ${p.events.toLocaleString("en-US")} events a month</span>
    <a class="btn ${i === 1 ? "btn-primary" : "btn-light"}" href="/signup">Start free</a></article>`).join("");
  const fill = (html: string) => html
    .replace("{{NAV}}", read("_nav.html")).replace("{{FOOTER}}", read("_footer.html"))
    .replaceAll("{{V_CSS}}", files["/site/site.css"].hash).replaceAll("{{V_JS}}", files["/site/site.js"].hash)
    .replaceAll("{{V_FILM}}", files["/site/film.js"].hash).replaceAll("{{V_SCENES}}", files["/site/film-scenes.js"].hash)
    .replaceAll("{{V_FILMDATA}}", filmData.hash).replaceAll("{{FONT}}", `/fonts/latin.woff2?v=${fonts["/fonts/latin.woff2"].hash}`)
    .replace("{{BUILDERS}}", builders).replace("{{SOURCES}}", sources).replace("{{PLANS}}", plans).replace("{{YEAR}}", String(new Date().getFullYear()))
    // The logo by its version too, so browsers show a new one at once rather than the one they kept.
    .replaceAll('"/favicon.svg"', `"/favicon.svg?v=${iconHash}"`);
  const pages = Object.fromEntries((["index", "pricing", "terms", "privacy", "dpa"] as const).map((name) => [name, asset(fill(read(`${name}.html`)), "text/html; charset=utf-8")]));
  return { files, pages };
}

// Where imports reach other services. Tests point them at a stand-in.
export type ImportApis = { request?: Outbound; open?: Outbound; google?: Partial<Google>; github?: string };

export async function createDashboard(options: {
  pool: pg.Pool; onSiteChanged: (key: string) => void; onNumbersChanged?: (projectId: string) => void; presence: Presence; hub: Hub; streets: Streets; mailer?: Mailer; imports?: ImportApis;
  // Polar, for Statiku's own plans; tests use a stand-in.
  polar?: Polar & { request?: Outbound };
  // How the site watcher looks at a site, and how icons are fetched; tests use stand-ins.
  probe?: Probe;
  fetchIcon?: typeof fetchIcon;
}) {
  const { pool, onSiteChanged, presence, hub, streets } = options;
  const mailer = options.mailer ?? smtpMailer();
  // Statiku's own account and websites, on whatever database this is (owner.ts).
  const setUpOwner = () => ownerSetup(pool).then((keys) => keys.forEach(onSiteChanged), (e) => console.error("Owner:", (e as Error).message));
  await setUpOwner();
  const polar = options.polar ?? polarFromEnv();
  const polarRequest = options.polar?.request ?? openRequest;
  const assets = await bundle();
  const signIns = new Attempts(10, 10 * 60_000);
  const checks = new Attempts(12, 60_000);
  const passwords = new Attempts(10, 10 * 60_000);
  // Reset links: a few per address an hour, so no one can fill a stranger's inbox.
  const resets = new Attempts(5, 15 * 60_000);
  const resetsTo = new Attempts(3, 60 * 60_000);

  function sendAsset(r: Request, asset: Asset, cache: string) {
    const gzip = /\bgzip\b/.test(r.req.headers["accept-encoding"] ?? "");
    // Asked for by another build's name: during a deploy the old and new versions both answer for a moment, and a
    // browser must not keep this build's file under the other's name for a year. It gets this one, uncached.
    const wanted = new URL(r.req.url ?? "/", "http://x").searchParams.get("v");
    r.res.writeHead(200, {
      "content-type": asset.type, "cache-control": wanted && wanted !== asset.hash ? "no-store" : cache, vary: "accept-encoding", ...HEADERS,
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    r.res.end(r.req.method === "HEAD" ? undefined : gzip ? asset.gzip : asset.data);
  }

  async function signedIn(r: Request): Promise<User> {
    const user = await userOf(pool, r.req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    return user;
  }

  async function mySite(user: User, key: string) {
    const site = await siteFor(pool, user.id, key);
    if (!site) throw new HttpError(404, "There's no such site in your account.");
    return site;
  }
  const ownerOnly = (site: Site) => {
    if (site.role !== "owner") throw new HttpError(403, "Only the site's owner can change or delete it.");
  };

  // The workspace a person's new sites and invitations belong to: the first one they own.
  async function ownWorkspace(userId: string) {
    const { rows: [own] } = await pool.query(
      `select w.id, w.name, (select count(*) from projects p where p.workspace_id = w.id)::int as sites, w.polar_customer_id as "customer", ${BILLING_COLUMNS}
         from memberships m join workspaces w on w.id = m.workspace_id
        where m.user_id = $1 and m.role = 'owner' order by m.created_at limit 1`,
      [userId],
    );
    if (!own) throw new HttpError(404, "There's no workspace for this account.");
    return own as { id: string; name: string; sites: number; customer: string | null } & Billing;
  }

  // What someone's own workspace pays for, how much it has used this month, and whether its reports are open.
  async function billingOf(userId: string) {
    const own = await ownWorkspace(userId);
    const plan = planOf(own.plan);
    const used = await usage(pool, own.id);
    return {
      access: access(own), plan: own.plan, planName: plan?.name ?? (own.plan === "comp" ? "Unlimited" : null), status: own.status,
      trialEndsAt: own.trialEndsAt, periodEnd: own.periodEnd, cancelAtPeriodEnd: own.cancelAtPeriodEnd,
      usage: used, limit: plan?.events ?? null, over: !!plan && used > plan.events, customer: !!own.customer,
    };
  }

  // Site icons: fetched from the site by this server, so no third party learns which sites someone tracks. Each gets a
  // fingerprint, which is in its address, so a changed icon is a new address and browsers fetch it again.
  const fetching = new Map<string, Promise<void>>();
  const getIcon = options.fetchIcon ?? fetchIcon;
  function refreshIcon(site: { id: string; domains: string[] }, newAddress = false) {
    let pending = fetching.get(site.id);
    if (!pending) {
      pending = getIcon(site.domains[0])
        .then((icon) => icon
          ? pool.query(
            "update projects set icon = $2, icon_type = $3, icon_version = $4, icon_checked_at = now() where id = $1",
            [site.id, icon.data, icon.type, createHash("sha256").update(icon.data).digest("hex").slice(0, 12)],
          )
          // None found: an icon found before stays, as the site may only be unreachable for a moment, unless the site
          // has a new address.
          : pool.query(`update projects set icon_checked_at = now()${newAddress ? ", icon = null, icon_type = null, icon_version = null" : ""} where id = $1`, [site.id]))
        .then(() => {}, (e) => console.error("Icon:", (e as Error).message))
        .finally(() => fetching.delete(site.id));
      fetching.set(site.id, pending);
    }
    return pending;
  }

  // ---------- Imports ----------
  const request = options.imports?.request ?? publicRequest;
  const open = options.imports?.open ?? openRequest;
  const google: Google = { ...GOOGLE, ...options.imports?.google };
  const githubApi = options.imports?.github ?? "https://api.github.com";
  // A Google sign-in, held in memory while the person picks a property and the import runs; never stored.
  const googleStates = new Map<string, { userId: string; key: string; until: number }>();
  const grants = new Map<string, { userId: string; key: string; access: string; refresh: string | null; expires: number; until: number }>();
  const forget = (map: Map<string, { until: number }>) => {
    for (const [k, v] of map) if (v.until < Date.now()) map.delete(k);
  };
  const googleCall = async (body: Record<string, string>) => {
    const res = await open(new URL(google.token), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: google.clientId ?? "", client_secret: google.clientSecret ?? "", ...body }).toString(),
    });
    const data = JSON.parse(res.body.toString("utf8") || "{}");
    if (!data.access_token) throw new HttpError(400, "Google didn't let Statiku in. Try connecting again.");
    return data as { access_token: string; expires_in: number; refresh_token?: string };
  };
  async function googleToken(grant: { access: string; refresh: string | null; expires: number }) {
    if (grant.expires - 60_000 > Date.now() || !grant.refresh) return grant.access;
    const data = await googleCall({ refresh_token: grant.refresh, grant_type: "refresh_token" });
    grant.access = data.access_token;
    grant.expires = Date.now() + data.expires_in * 1000;
    return grant.access;
  }
  function grantFor(id: unknown, user: User, site: Site) {
    forget(grants);
    const grant = typeof id === "string" ? grants.get(id) : undefined;
    if (!grant || grant.userId !== user.id || grant.key !== site.key) throw new HttpError(410, "The Google sign-in has expired. Connect again.");
    return grant;
  }
  // The same import twice would count everything twice.
  async function notImportedYet(site: Site, label: string | null, hash?: string) {
    const { rows: [twice] } = await pool.query(
      `select label from imports where project_id = $1 and status <> 'failed' and (label = $2 or ($3::text is not null and config->>'hash' = $3))`,
      [site.id, label, hash ?? null],
    );
    if (twice) throw new HttpError(409, `That's already imported (${twice.label}). Delete it first to import it again.`);
  }
  const begin = (site: Site, user: User, kind: string, label: string, run: Parameters<typeof startImport>[1]["run"]) =>
    startImport(pool, { projectId: site.id, userId: user.id, kind, label, run });

  // GitHub's download counts grow every day: each repository is looked at again every few hours, and what its releases
  // gained since is added on that day.
  async function refreshDownloads() {
    const { rows } = await pool.query(
      `select i.id, i.project_id, i.config, p.timezone from imports i join projects p on p.id = i.project_id where i.kind = 'github' and i.status = 'done'`,
    );
    for (const row of rows) {
      try {
        const releases = await githubReleases(open, githubApi, row.config.repo, row.config.token ? unseal(row.config.token) : null);
        const sink = new Sink(pool, row.id, row.project_id);
        await addDownloadsSince(sink, releases, row.config.counts ?? {}, row.timezone);
        await sink.flush();
        await pool.query(
          `update imports set config = config || $2::jsonb, rows = (select count(*) from imported_days where import_id = $1),
                  last_day = (select max(day) from imported_days where import_id = $1) where id = $1`,
          [row.id, JSON.stringify({ counts: countsOf(releases), refreshedAt: new Date().toISOString() })],
        );
      } catch (e) {
        console.error("GitHub downloads:", (e as Error).message);
      }
    }
  }
  setInterval(() => void refreshDownloads(), 6 * 3600_000).unref();

  // Emails to site owners when a site goes quiet or gets a rush (monitor.ts).
  const monitor = createMonitor({ pool, mailer, probe: options.probe, origin: () => process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:8787" });
  setInterval(() => void monitor.watch().catch((e) => console.error("Site watch:", (e as Error).message)), 5 * 60_000).unref();

  // A form with files, up to 100 MB, read by the platform's own parser.
  async function filesOf(req: IncomingMessage) {
    let size = 0;
    const limited = req.pipe(new Transform({
      transform(chunk: Buffer, _, done) {
        size += chunk.length;
        done(size > 100_000_000 ? new HttpError(413, "That's more than 100 MB. Import the files a few at a time.") : null, chunk);
      },
    }));
    const form = await new globalThis.Request("http://x/", {
      method: "POST", headers: { "content-type": String(req.headers["content-type"] ?? "") },
      body: Readable.toWeb(limited) as ReadableStream, duplex: "half",
    } as RequestInit).formData().catch((e) => {
      throw e instanceof HttpError ? e : new HttpError(400, "Send the files as a form.");
    });
    const files = await Promise.all(form.getAll("file").filter((f): f is File => typeof f !== "string").map(async (f) => ({ name: f.name.slice(0, 200), data: Buffer.from(await f.arrayBuffer()) })));
    if (!files.length) throw new HttpError(400, "Choose a file to import.");
    return files;
  }

  // A site's numbers: the report, a new key to send them with, a file of them, and deleting one.
  async function numbersApi(r: Request, site: Site, sub: string | undefined) {
    const { req, res } = r;
    const method = req.method ?? "GET";
    if (!sub && method === "GET") {
      if (access(site.billing) === "locked") throw new HttpError(402, "Your free trial has ended. Choose a plan to see your numbers again: Statiku has kept counting meanwhile.");
      const url = new URL(req.url ?? "/", "http://x");
      const range = url.searchParams.get("range") ?? "d30";
      return json(res, 200, await numbersReport(pool, site, RANGE_IDS.includes(range) ? range : "d30", { from: url.searchParams.get("from"), to: url.searchParams.get("to") }));
    }
    ownerOnly(site);
    const changed = () => options.onNumbersChanged?.(site.id);
    if (sub === "key" && method === "POST") {
      const key = await renewNumbersKey(pool, site.id);
      changed();
      return json(res, 200, { key });
    }
    if (sub === "upload" && method === "POST") {
      let saved = 0;
      const names = new Set<string>();
      for (const file of await filesOf(req)) {
        const parsed = parseNumbersFile(file.data.toString("utf8"));
        if (typeof parsed === "string") throw new HttpError(400, `${file.name}: ${parsed}`);
        const done = await saveNumbers(pool, site.id, parsed);
        saved += done.saved;
        done.names.forEach((n) => names.add(n));
      }
      changed();
      return json(res, 200, { saved, names: [...names] });
    }
    if (sub && method === "DELETE") {
      if (!(await deleteNumber(pool, site.id, sub))) throw new HttpError(404, "There's no such number on this site.");
      changed();
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, "Not found.");
  }

  async function importsApi(r: Request, user: User, site: Site, sub: string | undefined) {
    const { req, res } = r;
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://x");
    if (!sub && method === "GET") {
      const { rows } = await pool.query(`select ${IMPORT_COLUMNS}, config->>'repo' as repo, config->>'refreshedAt' as "refreshedAt" from imports where project_id = $1 order by created_at desc`, [site.id]);
      return json(res, 200, { imports: rows, google: !!(google.clientId && google.clientSecret), tokens: canSeal() });
    }
    ownerOnly(site);
    if (sub === "google/start" && method === "GET") {
      const back = (error: string) => {
        res.writeHead(302, { location: `/sites/${site.key}/import?error=${encodeURIComponent(error)}`, ...HEADERS });
        res.end();
      };
      if (!google.clientId || !google.clientSecret) return back("Signing in with Google isn't set up on this server yet. Export a CSV from Google Analytics instead.");
      forget(googleStates);
      const state = randomBytes(18).toString("base64url");
      googleStates.set(state, { userId: user.id, key: site.key, until: Date.now() + 15 * 60_000 });
      const to = new URL(google.auth);
      to.search = new URLSearchParams({
        client_id: google.clientId, redirect_uri: `${origin(r)}/api/imports/google/callback`, response_type: "code",
        scope: "https://www.googleapis.com/auth/analytics.readonly", access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
      }).toString();
      res.writeHead(302, { location: to.href, ...HEADERS });
      return res.end();
    }
    if (sub === "google/properties" && method === "GET") {
      const grant = grantFor(url.searchParams.get("grant"), user, site);
      return json(res, 200, { properties: await googleProperties(open, google, await googleToken(grant)) });
    }
    if (!sub && method === "POST") {
      const body = await readJson(req);
      if (body.kind === "ga4") {
        const grant = grantFor(body.grant, user, site);
        const property = text(body.property, 20);
        const label = `Google Analytics: ${text(body.name, 80) || "property"} (GA4 ${property})`;
        await notImportedYet(site, label);
        // The sign-in lasts as long as the import needs it.
        grant.until = Date.now() + 6 * 3600_000;
        const { created } = await begin(site, user, "ga4", label, (sink) => importGoogle(sink, open, google, () => googleToken(grant), property));
        return json(res, 202, { import: created });
      }
      if (body.kind === "plausible") {
        let host: URL;
        try {
          host = new URL(text(body.host, 300) || "https://plausible.io");
        } catch {
          throw new HttpError(400, "Enter your Plausible's address, such as https://plausible.io.");
        }
        if (!/^https?:$/.test(host.protocol)) throw new HttpError(400, "Enter your Plausible's address, such as https://plausible.io.");
        const key = text(body.key, 200), siteId = text(body.site, 253);
        if (!key) throw new HttpError(400, "Paste your Plausible Stats API key.");
        if (!siteId) throw new HttpError(400, "Enter the site's domain as it's named in Plausible.");
        const label = `Plausible: ${siteId}${host.host === "plausible.io" ? "" : ` on ${host.host}`}`;
        await notImportedYet(site, label);
        const { created } = await begin(site, user, "plausible", label, (sink) => importPlausible(sink, request, { host, key, site: siteId }));
        return json(res, 202, { import: created });
      }
      if (body.kind === "github") {
        const repo = repoOf(body.repo);
        if (!repo) throw new HttpError(400, "Enter the repository as owner/name, or its github.com address.");
        const token = text(body.token, 300) || null;
        const label = `GitHub: ${repo}`;
        await notImportedYet(site, label);
        const { created } = await begin(site, user, "github", label, async (sink) => {
          const releases = await githubReleases(open, githubApi, repo, token);
          if (!releases.length) throw new Error(`${repo} has no releases on GitHub.`);
          await importGithub(sink, releases, site.timezone);
          // A token is kept only sealed; without SECRET_KEY, later refreshes go without it.
          return {
            config: { repo, counts: countsOf(releases), refreshedAt: new Date().toISOString(), ...(token && canSeal() ? { token: seal(token) } : {}) },
            note: token && !canSeal() ? "The token was used once and not kept, so daily refreshes only work if the repository is public." : null,
          };
        });
        return json(res, 202, { import: created });
      }
      throw new HttpError(400, "Choose what to import from.");
    }
    if (sub === "file" && method === "POST") {
      const files = await filesOf(req);
      const hash = files.reduce((h, f) => h.update(f.data), createHash("sha256")).digest("hex");
      const label = `File: ${files.map((f) => f.name).join(", ")}`.slice(0, 200);
      await notImportedYet(site, null, hash);
      const { created } = await begin(site, user, "file", label, async (sink) => ({ ...(await importFiles(sink, files, site.timezone)), config: { hash } }));
      return json(res, 202, { import: created });
    }
    if (sub && /^[0-9a-f-]{36}$/.test(sub) && method === "DELETE") {
      await pool.query("delete from imports where id = $1 and project_id = $2", [sub, site.id]);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, "Not found.");
  }

  async function invite(token: string) {
    const { rows: [found] } = await pool.query(
      `select i.id, i.workspace_id, i.role, i.expires_at < now() as expired, i.accepted_at is not null as used, w.name as workspace, u.name as invited_by
         from invites i join workspaces w on w.id = i.workspace_id left join users u on u.id = i.created_by
        where i.token_hash = $1`,
      [hashToken(token)],
    );
    return found ?? null;
  }
  async function acceptInvite(token: string, userId: string) {
    const found = await invite(token);
    if (!found || found.expired || found.used) throw new HttpError(410, "This invitation has expired or was already used. Ask for a new one.");
    await pool.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3) on conflict do nothing", [found.workspace_id, userId, found.role]);
    await pool.query("update invites set accepted_by = $2, accepted_at = now() where id = $1", [found.id, userId]);
    return found.workspace as string;
  }

  // This service's address, for the snippet and for links in emails: PUBLIC_URL, or the address Render gives it. Only
  // on a laptop does it come from the request, whose Host header anyone can write.
  const origin = (r: Request) =>
    process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `${r.secure ? "https" : "http"}://${r.req.headers.host ?? "localhost"}`;
  const snippet = (r: Request, key: string) => `<script defer data-project="${key}" src="${origin(r)}/s.js"></script>`;
  const me = (user: User) => ({ id: user.id, name: user.name, email: user.email, photo: user.avatarAt ? new Date(user.avatarAt).getTime() : null });

  async function api(r: Request) {
    const { req, res, path } = r;
    const method = req.method ?? "GET";
    // Changes come only from this app's own pages.
    const from = req.headers.origin;
    if (method !== "GET" && from && URL.parse(from)?.host !== req.headers.host) throw new HttpError(403, "Not from this site.");

    if (path === "/api/signup" && method === "POST") {
      if (!signIns.allow(r.ip)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const body = await readJson(req);
      const name = text(body.name, 80), email = cleanEmail(body.email), password = typeof body.password === "string" ? body.password : "";
      if (!name) throw new HttpError(400, "Enter your name.");
      if (!emailLooksRight(email)) throw new HttpError(400, "Enter a valid email address.");
      if (password.length < 8 || password.length > 200) throw new HttpError(400, "Use a password of at least 8 characters.");
      const user = await createUser(pool, name, email, password);
      if (!user) throw new HttpError(409, "There's already an account with this email. Sign in instead.");
      if (email === OWNER) await setUpOwner();
      const joined = typeof body.invite === "string" ? await acceptInvite(body.invite, user.id).catch(() => null) : null;
      return json(res, 201, { user: me(user), joined }, { "set-cookie": loginCookie(await startLogin(pool, user.id), r.secure) });
    }
    if (path === "/api/login" && method === "POST") {
      if (!signIns.allow(r.ip)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const body = await readJson(req);
      const user = await findByPassword(pool, cleanEmail(body.email), typeof body.password === "string" ? body.password : "");
      if (!user) throw new HttpError(401, "That email and password don't match an account.");
      return json(res, 200, { user: me(user) }, { "set-cookie": loginCookie(await startLogin(pool, user.id), r.secure) });
    }
    if (path === "/api/logout" && method === "POST") {
      await endLogin(pool, req);
      return json(res, 200, { ok: true }, { "set-cookie": clearedCookie(r.secure) });
    }
    // Polar, telling of a subscription that started, renewed, changed or ended.
    if (path === "/api/polar/webhook" && method === "POST") {
      const body = await readRaw(req, 1_000_000);
      const header = (name: string) => [req.headers[name]].flat()[0];
      if (!verifyWebhook(polar.secret ?? "", { id: header("webhook-id"), timestamp: header("webhook-timestamp"), signature: header("webhook-signature") }, body)) {
        throw new HttpError(401, "That isn't signed by Polar.");
      }
      const event = JSON.parse(body.toString("utf8") || "{}");
      await applySubscription(pool, polar, event, new Date(Number(header("webhook-timestamp")) * 1000));
      return json(res, 202, { ok: true });
    }
    if (path === "/api/password/forgot" && method === "POST") {
      if (!resets.allow(r.ip)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const email = cleanEmail((await readJson(req)).email);
      if (!emailLooksRight(email)) throw new HttpError(400, "Enter a valid email address.");
      // The same answer whether or not there's an account, and the email goes out after it.
      if (resetsTo.allow(email)) {
        void startReset(pool, email)
          .then(async (found) => {
            if (!found) return;
            const url = `${origin(r)}/reset/${found.token}`;
            await mailer({
              to: found.user.email, subject: "Choose a new Statiku password",
              ...letter({
                heading: "Choose a new password",
                lines: [`Hi ${found.user.name}, someone (hopefully you) asked to reset the password of your Statiku account.`, "The link works once, for an hour."],
                button: { label: "Choose a new password", url },
                foot: "If you didn't ask, ignore this email: your password stays as it is.",
              }),
            });
          })
          .catch((e) => console.error("Password reset email:", (e as Error).message));
      }
      return json(res, 200, { ok: true });
    }
    const reset = path.match(/^\/api\/password\/reset\/([\w-]{20,80})$/);
    if (reset && method === "GET") {
      const found = await resetFor(pool, reset[1]);
      return json(res, 200, found ? { valid: true, email: found.email } : { valid: false });
    }
    if (reset && method === "POST") {
      if (!resets.allow(r.ip)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const password = (await readJson(req)).password;
      if (typeof password !== "string" || password.length < 8 || password.length > 200) throw new HttpError(400, "Use a password of at least 8 characters.");
      const found = await finishReset(pool, reset[1], password);
      if (!found) throw new HttpError(410, "This link has expired or was already used. Ask for a new one.");
      return json(res, 200, { user: me(found) }, { "set-cookie": loginCookie(await startLogin(pool, found.id), r.secure) });
    }
    const invitation = path.match(/^\/api\/invites\/([\w-]{20,80})(\/accept)?$/);
    if (invitation && !invitation[2] && method === "GET") {
      const found = await invite(invitation[1]);
      if (!found) throw new HttpError(404, "This invitation link isn't right. Ask for a new one.");
      return json(res, 200, { workspace: found.workspace, invitedBy: found.invited_by, valid: !found.expired && !found.used });
    }

    const paying = path.match(/^\/api\/pay\/(stripe|polar)\/(p_[a-z0-9]{6,20})$/);
    if (paying && method === "POST") {
      const provider = paying[1] as Provider;
      const site = await payingSite(pool, paying[2], provider);
      if (!site) throw new HttpError(404, `This site isn't connected to ${provider === "stripe" ? "Stripe" : "Polar"} in Statiku.`);
      const body = await readRaw(req, 1_000_000);
      const header = (name: string) => [req.headers[name]].flat()[0];
      if (!verifyPayment(provider, site.secret, header, body)) throw new HttpError(401, "That isn't signed with this site's webhook secret.");
      let event: { type?: string; data?: unknown };
      try {
        event = JSON.parse(body.toString("utf8") || "{}");
      } catch {
        throw new HttpError(400, "The body isn't JSON.");
      }
      const payment = paymentOf(provider, event);
      // Anything that isn't a payment is fine to send, and changes nothing.
      if (!payment) return json(res, 202, { ok: true, payment: false });
      return json(res, 202, { ok: true, ...(await recordPayment(pool, hub, site.id, provider, payment)) });
    }
    const shared = path.match(/^\/api\/match\/([\w-]{20,40})(\/stream)?$/);
    if (shared && method === "GET") {
      const site = await siteByMatchToken(pool, shared[1]);
      if (!site) throw new HttpError(404, "This match link has been turned off, or there's no such link.");
      if (access(site.billing) === "locked") throw new HttpError(402, "This site's reports are closed for now.");
      if (shared[2]) return liveStream(r, site.id, true);
      return json(res, 200, await matchSummary(pool, site, presence(site.id)));
    }
    const user = await signedIn(r);
    if (invitation?.[2] && method === "POST") return json(res, 200, { workspace: await acceptInvite(invitation[1], user.id) });

    // Back from signing in with Google: the code becomes a grant this person can use for a while.
    if (path === "/api/imports/google/callback" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://x");
      forget(googleStates);
      const state = googleStates.get(url.searchParams.get("state") ?? "");
      if (!state || state.userId !== user.id) throw new HttpError(400, "That Google sign-in didn't start here. Try again from the Import page.");
      googleStates.delete(url.searchParams.get("state")!);
      let to = `/sites/${state.key}/import`;
      const code = url.searchParams.get("code");
      if (!code) to += `?error=${encodeURIComponent("Google sign-in was cancelled.")}`;
      else {
        const data = await googleCall({ code, redirect_uri: `${origin(r)}/api/imports/google/callback`, grant_type: "authorization_code" });
        const id = randomBytes(18).toString("base64url");
        grants.set(id, { userId: user.id, key: state.key, access: data.access_token, refresh: data.refresh_token ?? null, expires: Date.now() + data.expires_in * 1000, until: Date.now() + 30 * 60_000 });
        to += `?google=${id}`;
      }
      res.writeHead(302, { location: to, ...HEADERS });
      return res.end();
    }
    const importing = path.match(/^\/api\/sites\/(p_[a-z0-9]{6,20})\/imports(?:\/(file|google\/start|google\/properties|[0-9a-f-]{36}))?$/);
    if (importing) return importsApi(r, user, await mySite(user, importing[1]), importing[2]);

    // ---------- Your account ----------
    if (path === "/api/me" && method === "GET") return json(res, 200, { user: me(user), billing: await billingOf(user.id).catch(() => null) });

    // ---------- Your plan ----------
    if (path === "/api/billing" && method === "GET") {
      const own = await ownWorkspace(user.id);
      return json(res, 200, {
        ...(await billingOf(user.id)), plans: PLANS, owner: true, workspace: own.name,
        // Which plans and periods can be bought on this server: those with a product in Polar.
        buyable: polar.token ? Object.keys(polar.products) : [],
      });
    }
    if (path === "/api/billing/checkout" && method === "POST") {
      const body = await readJson(req);
      const plan = planOf(text(body.plan, 20)), interval = body.interval === "year" ? "year" : "month";
      const product = plan && polar.products[`${plan.id}:${interval}`];
      if (!plan || !product || !polar.token) throw new HttpError(400, "That plan can't be bought here yet.");
      const own = await ownWorkspace(user.id);
      // A second checkout would start a second subscription: a paying workspace changes plan in Polar's portal.
      if (own.customer && access(own) === "paid" && !own.cancelAtPeriodEnd) throw new HttpError(409, "You already have a plan. Change it under Invoices, card and cancelling.");
      const url = await checkoutUrl(polarRequest, polar, { product, workspaceId: own.id, email: user.email, success: `${origin(r)}/plan?billing=done` })
        .catch((e) => {
          throw new HttpError(502, (e as Error).message);
        });
      return json(res, 200, { url });
    }
    if (path === "/api/billing/portal" && method === "POST") {
      if (!polar.token) throw new HttpError(400, "Billing isn't set up on this server yet.");
      const own = await ownWorkspace(user.id);
      const url = await portalUrl(polarRequest, polar, own.id, `${origin(r)}/plan`);
      if (!url) throw new HttpError(404, "There's no billing account yet. Choose a plan first.");
      return json(res, 200, { url });
    }
    if (path === "/api/me" && method === "PATCH") {
      const body = await readJson(req);
      const name = body.name === undefined ? user.name : text(body.name, 80);
      const email = body.email === undefined ? user.email : cleanEmail(body.email);
      if (!name) throw new HttpError(400, "Enter your name.");
      if (!emailLooksRight(email)) throw new HttpError(400, "Enter a valid email address.");
      const { rowCount } = await pool.query(
        "update users set name = $2, email = $3 where id = $1 and not exists (select 1 from users where email = $3 and id <> $1)",
        [user.id, name, email],
      );
      if (!rowCount) throw new HttpError(409, "Another account already uses that email.");
      return json(res, 200, { user: me({ ...user, name, email }) });
    }
    if (path === "/api/me" && method === "DELETE") {
      if (!passwords.allow(user.id)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const body = await readJson(req);
      if (!(await findByPassword(pool, user.email, typeof body.password === "string" ? body.password : ""))) throw new HttpError(401, "That password isn't right.");
      await deleteAccount(pool, user.id, async (site) => {
        await deleteProject(pool, site.id);
        onSiteChanged(site.key);
      });
      return json(res, 200, { ok: true }, { "set-cookie": clearedCookie(r.secure) });
    }
    if (path === "/api/me/password" && method === "POST") {
      if (!passwords.allow(user.id)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const body = await readJson(req);
      const next = typeof body.password === "string" ? body.password : "";
      if (!(await findByPassword(pool, user.email, typeof body.current === "string" ? body.current : ""))) throw new HttpError(401, "Your current password isn't right.");
      if (next.length < 8 || next.length > 200) throw new HttpError(400, "Use a new password of at least 8 characters.");
      await changePassword(pool, req, user.id, next);
      return json(res, 200, { ok: true });
    }
    if (path === "/api/me/photo") {
      if (method === "GET") {
        const { rows: [row] } = await pool.query("select avatar, avatar_type from users where id = $1", [user.id]);
        if (!row?.avatar) throw new HttpError(404, "No photo.");
        return image(res, row.avatar_type, row.avatar);
      }
      if (method === "DELETE") {
        await pool.query("update users set avatar = null, avatar_type = null, avatar_at = null where id = $1", [user.id]);
        return json(res, 200, { user: me({ ...user, avatarAt: null }) });
      }
      if (method === "POST") {
        // The app crops and shrinks the photo to 256 pixels before sending it.
        const body = await readJson(req, 600_000);
        const data = text(body.image, 560_000).match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=]+)$/i);
        const bytes = data ? Buffer.from(data[2], "base64") : null;
        const type = bytes && bytes.length <= 400_000 ? imageType(bytes) : null;
        if (!bytes || !type || !/^image\/(png|jpeg|webp)$/.test(type)) throw new HttpError(400, "Use a PNG, JPEG or WebP photo.");
        const { rows: [row] } = await pool.query("update users set avatar = $2, avatar_type = $3, avatar_at = now() where id = $1 returning avatar_at", [user.id, bytes, type]);
        return json(res, 200, { user: me({ ...user, avatarAt: row.avatar_at }) });
      }
    }

    // ---------- Your team ----------
    if (path === "/api/team" && method === "GET") {
      const own = await ownWorkspace(user.id);
      const [{ rows: members }, { rows: invites }] = await Promise.all([
        pool.query(
          `select u.id, u.name, u.email, m.role, u.avatar_at is not null as photo from memberships m join users u on u.id = m.user_id
            where m.workspace_id = $1 order by m.role = 'owner' desc, m.created_at`,
          [own.id],
        ),
        pool.query(
          `select i.id, i.created_at, i.expires_at, u.name as by from invites i left join users u on u.id = i.created_by
            where i.workspace_id = $1 and i.accepted_at is null and i.expires_at > now() order by i.created_at desc`,
          [own.id],
        ),
      ]);
      return json(res, 200, { workspace: { name: own.name, sites: own.sites }, members: members.map((m) => ({ ...m, you: m.id === user.id })), invites });
    }
    if (path === "/api/team/invites" && method === "POST") {
      const own = await ownWorkspace(user.id);
      const token = randomBytes(24).toString("base64url");
      const { rows: [created] } = await pool.query(
        `insert into invites (workspace_id, token_hash, created_by, expires_at) values ($1, $2, $3, now() + make_interval(days => $4))
         returning id, created_at, expires_at`,
        [own.id, hashToken(token), user.id, INVITE_DAYS],
      );
      return json(res, 201, { invite: { ...created, by: user.name }, link: `${origin(r)}/join/${token}` });
    }
    const teamItem = path.match(/^\/api\/team\/(invites|members)\/([0-9a-f-]{36})$/);
    if (teamItem && method === "DELETE") {
      const own = await ownWorkspace(user.id);
      if (teamItem[1] === "invites") {
        await pool.query("delete from invites where id = $1 and workspace_id = $2", [teamItem[2], own.id]);
      } else {
        if (teamItem[2] === user.id) throw new HttpError(400, "You can't remove yourself from your own workspace.");
        await pool.query("delete from memberships where workspace_id = $1 and user_id = $2 and role <> 'owner'", [own.id, teamItem[2]]);
      }
      return json(res, 200, { ok: true });
    }

    // ---------- Sites ----------
    if (path === "/api/sites" && method === "GET") return json(res, 200, { sites: await overview(pool, user.id, presence, (s) => void refreshIcon(s)) });
    if (path === "/api/sites" && method === "POST") {
      const body = await readJson(req);
      const domain = domainOf(body.address);
      if (!domain) throw new HttpError(400, "Enter your website's address, such as example.com.");
      const own = await ownWorkspace(user.id);
      if (own.sites >= MAX_SITES) throw new HttpError(400, `An account can have up to ${MAX_SITES} sites for now.`);
      // The same address twice would split its visits between two sites.
      const { rows: [twice] } = await pool.query("select name from projects where workspace_id = $1 and $2 = any(domains)", [own.id, domain]);
      if (twice) throw new HttpError(409, `${domain} is already one of your websites (${twice.name}). Open it from Websites.`);
      const site = await createProject(pool, text(body.name, 80) || domain, [domain], zoneOf(body.timezone), own.id);
      void refreshIcon(site);
      return json(res, 201, { site: { key: site.key, name: site.name, domains: site.domains, timezone: site.timezone } });
    }

    const matchLink = path.match(/^\/api\/sites\/(p_[a-z0-9]{6,20})\/match\/link$/);
    if (matchLink && (method === "POST" || method === "DELETE")) {
      const site = await mySite(user, matchLink[1]);
      ownerOnly(site);
      if (method === "DELETE") {
        await stopSharingMatch(pool, site.id);
        return json(res, 200, { url: null });
      }
      return json(res, 200, { url: `${origin(r)}/m/${await shareMatch(pool, site.id)}` });
    }
    const numbersAt = path.match(/^\/api\/sites\/(p_[a-z0-9]{6,20})\/numbers(?:\/([^/]{1,200}))?$/);
    if (numbersAt) return numbersApi(r, await mySite(user, numbersAt[1]), numbersAt[2] ? decodeURIComponent(numbersAt[2]) : undefined);

    const match = path.match(/^\/api\/sites\/(p_[a-z0-9]{6,20})(\/[a-z]+)?$/);
    if (!match) throw new HttpError(404, "Not found.");
    const site = await mySite(user, match[1]);
    const action = match[2] ?? "";

    if (action === "" && method === "GET") {
      const { rows: [info] } = await pool.query(
        `select created_at, match_token, stripe_secret is not null as stripe, polar_secret is not null as polar, (select ts from events where project_id = $1 order by ts desc limit 1) as last_event_at from projects where id = $1`,
        [site.id],
      );
      return json(res, 200, {
        site: {
          key: site.key, name: site.name, domains: site.domains, timezone: site.timezone, role: site.role, askLocation: site.askLocation,
          alertQuiet: site.alertQuiet, alertSurge: site.alertSurge, goals: site.goals ?? null, defaultGoals: goalsOf({}),
          matchUrl: info.match_token ? `${origin(r)}/m/${info.match_token}` : null,
          payments: {
            stripe: info.stripe, polar: info.polar, canSeal: canSeal(),
            stripeUrl: `${origin(r)}/api/pay/stripe/${site.key}`, polarUrl: `${origin(r)}/api/pay/polar/${site.key}`,
          },
          createdAt: info.created_at, lastEventAt: info.last_event_at,
        },
        snippet: snippet(r, site.key),
        scriptUrl: `${origin(r)}/s.js`,
      });
    }
    if (action === "" && method === "PATCH") {
      ownerOnly(site);
      const body = await readJson(req);
      const name = body.name === undefined ? site.name : text(body.name, 80);
      if (!name) throw new HttpError(400, "Give the site a name.");
      let domains = site.domains;
      if (body.domains !== undefined) {
        if (!Array.isArray(body.domains)) throw new HttpError(400, "Domains must be a list.");
        domains = [...new Set(body.domains.map(domainOf))].filter((d): d is string => !!d).slice(0, 20);
        if (!domains.length) throw new HttpError(400, "Keep at least one domain.");
      }
      const timezone = body.timezone === undefined ? site.timezone : zoneOf(body.timezone);
      const askLocation = typeof body.askLocation === "boolean" ? body.askLocation : site.askLocation;
      const alertQuiet = typeof body.alertQuiet === "boolean" ? body.alertQuiet : site.alertQuiet;
      const alertSurge = typeof body.alertSurge === "boolean" ? body.alertSurge : site.alertSurge;
      const goals = body.goals === undefined ? site.goals ?? null : cleanGoals(body.goals);
      for (const [field, column] of [["stripeSecret", "stripe_secret"], ["polarSecret", "polar_secret"]] as const) {
        if (body[field] === undefined) continue;
        const secret = body[field] === null ? null : text(body[field], 300);
        if (secret && !canSeal()) throw new HttpError(400, "This server needs a SECRET_KEY to keep payment secrets.");
        await pool.query(`update projects set ${column} = $2 where id = $1`, [site.id, secret ? seal(secret) : null]);
      }
      await pool.query(
        "update projects set name = $2, domains = $3, timezone = $4, ask_location = $5, alert_quiet = $6, alert_surge = $7, goals = $8 where id = $1",
        [site.id, name, domains, timezone, askLocation, alertQuiet, alertSurge, goals],
      );
      onSiteChanged(site.key);
      if (domains[0] !== site.domains[0]) void refreshIcon({ id: site.id, domains }, true);
      return json(res, 200, { site: { key: site.key, name, domains, timezone, askLocation, alertQuiet, alertSurge, goals } });
    }
    if (action === "" && method === "DELETE") {
      ownerOnly(site);
      const body = await readJson(req);
      if (text(body.confirm, 253).toLowerCase() !== site.domains[0]) throw new HttpError(400, `Type ${site.domains[0]} to confirm.`);
      await deleteProject(pool, site.id);
      onSiteChanged(site.key);
      return json(res, 200, { ok: true });
    }
    if (action === "/icon" && method === "GET") {
      const read = async () => (await pool.query("select icon, icon_type, icon_checked_at from projects where id = $1", [site.id])).rows[0];
      let row = await read();
      // Never looked for: wait for it (briefly). Due for another look: show the one there is and look again behind it.
      if (!row.icon_checked_at) {
        await Promise.race([refreshIcon(site), new Promise((resolve) => setTimeout(resolve, 9000))]);
        row = await read();
      } else if (Date.now() - row.icon_checked_at.getTime() > (row.icon ? ICON_FRESH.found : ICON_FRESH.missing)) {
        void refreshIcon(site);
      }
      if (!row.icon) throw new HttpError(404, "No icon.");
      return image(res, row.icon_type, row.icon);
    }
    if (action === "/check" && method === "POST") {
      if (!checks.allow(user.id)) throw new HttpError(429, "Wait a minute before checking again.");
      return json(res, 200, await checkInstall(site.domains[0], site.key));
    }
    // After an unpaid trial the reports close until a plan is chosen; the site is still counted meanwhile.
    if (["/stats", "/live", "/stream", "/match", "/momentum", "/insights", "/heatmap"].includes(action) && access(site.billing) === "locked") {
      throw new HttpError(402, site.role === "owner"
        ? "Your free trial has ended. Choose a plan to see your numbers again: Statiku has kept counting meanwhile."
        : "This team's free trial has ended. Its owner can choose a plan to open the reports again.");
    }
    if (action === "/stats" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://x");
      const range = url.searchParams.get("range") ?? "d30";
      const filters = Object.fromEntries(FILTERS.map((f) => [f, text(url.searchParams.get(f), 300) || null])) as Filters;
      return json(res, 200, await stats(pool, site, RANGE_IDS.includes(range) ? range : "d30", filters, {
        from: url.searchParams.get("from"), to: url.searchParams.get("to"), by: url.searchParams.get("by"),
      }));
    }
    if (action === "/live" && method === "GET") return json(res, 200, await live(pool, site, presence(site.id), streets));
    if (action === "/match" && method === "GET") return json(res, 200, await matchSummary(pool, site, presence(site.id)));
    if (action === "/momentum" && method === "GET") return json(res, 200, await momentum(pool, site));
    if ((action === "/insights" || action === "/heatmap") && method === "GET") {
      const url = new URL(req.url ?? "/", "http://x");
      const range = url.searchParams.get("range") ?? "d30";
      const b = await bounds(pool, site.id, site.timezone, RANGE_IDS.includes(range) ? range : "d30", { from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      if (action === "/heatmap") {
        return json(res, 200, { range: b, ...(await heatmap(pool, site, b.from, b.to, text(url.searchParams.get("path"), 512) || null, text(url.searchParams.get("device"), 20) || null)) });
      }
      const [helped, hurt, earned] = await Promise.all([
        assists(pool, site, b.from, b.to, goalsOf(site)), injuries(pool, site, b.from, b.to), revenue(pool, site, b.from, b.to, b.prevFrom, b.prevTo),
      ]);
      const rated = await ratings(pool, site, b.from, b.to, new Map(helped.pages.map((p) => [p.label, p.v])), helped.goals);
      return json(res, 200, { range: b, assists: { ...helped, pages: helped.pages.slice(0, 12) }, ratings: rated, injuries: hurt, revenue: earned });
    }
    if (action === "/stream" && method === "GET") return liveStream(r, site.id);
    throw new HttpError(404, "Not found.");
  }

  // Server-sent events: each event on the site as it's collected, each number sent, and a nudge when someone arrives
  // or leaves. At a shared match link, events go without the visitor's device details.
  function liveStream({ req, res }: Request, projectId: string, shared = false) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", ...HEADERS });
    res.write("retry: 3000\n\n");
    const stop = hub.subscribe(projectId, (message) => {
      if (shared && message.startsWith('{"t":"event"')) {
        const { t, e } = JSON.parse(message);
        message = JSON.stringify({ t, e: { ts: e.ts, name: e.name, path: e.path, country: e.country, city: e.city, source: e.source, revenue: e.revenue, first: e.first, app: e.app } });
      }
      res.write(`data: ${message}\n\n`);
    });
    // A comment now and then keeps proxies from closing a quiet stream.
    const keepAlive = setInterval(() => res.write(": still here\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      stop();
    });
  }

  return Object.assign(async function handle(r: Request) {
    const { req, res, path } = r;
    try {
      if (path.startsWith("/api/")) return await api(r);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Not allowed.");
      if (path === "/app.js") return sendAsset(r, assets.js, "public, max-age=31536000, immutable");
      if (path === "/app.css") return sendAsset(r, assets.css, "public, max-age=31536000, immutable");
      // Pages ask for the logo by its version, which never changes; asked for without one, it's kept for an hour.
      if (path === "/favicon.svg") return sendAsset(r, assets.icon, /[?&]v=/.test(req.url ?? "") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
      if (path === "/geo/countries-50m.json") return sendAsset(r, assets.map, "public, max-age=604800");
      if (Object.hasOwn(assets.fonts, path)) return sendAsset(r, assets.fonts[path as keyof typeof assets.fonts], "public, max-age=31536000, immutable");
      if (Object.hasOwn(assets.site.files, path)) return sendAsset(r, assets.site.files[path], "public, max-age=31536000, immutable");
      const own = path.match(/^\/(pricing|terms|privacy|dpa)$/);
      if (own) return sendAsset(r, assets.site.pages[own[1]], "no-cache");
      // The landing page for anyone not signed in; the app for everyone who is.
      if (path === "/" && !(await userOf(pool, req))) return sendAsset(r, assets.site.pages.index, "no-cache");
      // Every other address is a page of the app, which works out what to show.
      return sendAsset(r, assets.html, "no-cache");
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error("Dashboard:", (e as Error).message);
      if (!res.headersSent) json(res, 500, { error: "Something went wrong on our side. Try again." });
    }
  }, { jobs: { refreshDownloads, watchSites: monitor.watch } });
}
