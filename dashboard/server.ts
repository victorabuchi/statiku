// The dashboard, served by the same service as the script: accounts, the sites a person tracks, and their numbers.
// The pages are one app (client/), bundled when the service starts; everything it shows comes from /api.
//   GET    /  /login  /signup  /sites/…        the app
//   POST   /api/signup  /api/login  /api/logout
//   GET    /api/me
//   GET    /api/sites                          every site with today's numbers
//   POST   /api/sites                          add a site: { address, name?, timezone? }
//   GET    /api/sites/:key                     PATCH { name?, domains?, timezone? }   DELETE { confirm: domain }
//   POST   /api/sites/:key/check               is the tracking code on the site?
//   GET    /api/sites/:key/stats?range=&source=
//   GET    /api/sites/:key/live
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import type pg from "pg";
import { cleanDomain } from "../ingest/projects.ts";
import { createProject, deleteProject } from "../scripts/project.ts";
import { Attempts, clearedCookie, cleanEmail, createUser, emailLooksRight, endLogin, findByPassword, loginCookie, startLogin, userOf, type User } from "./auth.ts";
import { checkInstall } from "./check.ts";
import { live, overview, RANGE_IDS, siteFor, stats } from "./stats.ts";

export type Request = { req: IncomingMessage; res: ServerResponse; path: string; ip: string; secure: boolean };

const MAX_SITES = 50;
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "");

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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return Promise.reject(new HttpError(415, "Send JSON."));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) reject(new HttpError(413, "That's too much."));
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

// The app's script and styles, built once: content-hashed names so browsers keep them until the next deploy.
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
    return { data, gzip: gzipSync(data), type, hash: createHash("sha256").update(data).digest("base64url").slice(0, 12) };
  };
  const js = asset(outputFiles[0].contents, "text/javascript; charset=utf-8");
  const css = asset(readFileSync(new URL("app.css", dir)), "text/css; charset=utf-8");
  const icon = asset(readFileSync(new URL("icon.svg", dir)), "image/svg+xml");
  const html = asset(
    readFileSync(new URL("index.html", dir), "utf8").replace("/app.js", `/app.js?v=${js.hash}`).replace("/app.css", `/app.css?v=${css.hash}`),
    "text/html; charset=utf-8",
  );
  return { js, css, icon, html };
}

export async function createDashboard(options: { pool: pg.Pool; onSiteChanged: (key: string) => void }) {
  const { pool, onSiteChanged } = options;
  const assets = await bundle();
  const signIns = new Attempts(10, 10 * 60_000);
  const checks = new Attempts(12, 60_000);

  function sendAsset(r: Request, asset: Awaited<ReturnType<typeof bundle>>["js"], cache: string) {
    const gzip = /\bgzip\b/.test(r.req.headers["accept-encoding"] ?? "");
    r.res.writeHead(200, {
      "content-type": asset.type, "cache-control": cache, vary: "accept-encoding", ...HEADERS,
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    r.res.end(r.req.method === "HEAD" ? undefined : gzip ? asset.gzip : asset.data);
  }

  async function signedIn(r: Request): Promise<User> {
    const user = await userOf(pool, r.req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    return user;
  }

  async function mySite(r: Request, user: User, key: string) {
    const site = await siteFor(pool, user.id, key);
    if (!site) throw new HttpError(404, "There's no such site in your account.");
    return site;
  }

  // The script's address, as this service is reached: the snippet points at wherever the dashboard is.
  const origin = (r: Request) => process.env.PUBLIC_URL ?? `${r.secure ? "https" : "http"}://${r.req.headers.host ?? "localhost"}`;
  const snippet = (r: Request, key: string) => `<script defer data-project="${key}" src="${origin(r)}/s.js"></script>`;

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
      return json(res, 201, { user }, { "set-cookie": loginCookie(await startLogin(pool, user.id), r.secure) });
    }
    if (path === "/api/login" && method === "POST") {
      if (!signIns.allow(r.ip)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
      const body = await readJson(req);
      const user = await findByPassword(pool, cleanEmail(body.email), typeof body.password === "string" ? body.password : "");
      if (!user) throw new HttpError(401, "That email and password don't match an account.");
      return json(res, 200, { user }, { "set-cookie": loginCookie(await startLogin(pool, user.id), r.secure) });
    }
    if (path === "/api/logout" && method === "POST") {
      await endLogin(pool, req);
      return json(res, 200, { ok: true }, { "set-cookie": clearedCookie(r.secure) });
    }

    const user = await signedIn(r);
    if (path === "/api/me" && method === "GET") return json(res, 200, { user });

    if (path === "/api/sites" && method === "GET") return json(res, 200, { sites: await overview(pool, user.id) });
    if (path === "/api/sites" && method === "POST") {
      const body = await readJson(req);
      const domain = domainOf(body.address);
      if (!domain) throw new HttpError(400, "Enter your website's address, such as example.com.");
      const { rows: [own] } = await pool.query(
        `select m.workspace_id, (select count(*) from projects p where p.workspace_id = m.workspace_id)::int as sites
           from memberships m where m.user_id = $1 and m.role = 'owner' order by m.created_at limit 1`,
        [user.id],
      );
      if (own.sites >= MAX_SITES) throw new HttpError(400, `An account can have up to ${MAX_SITES} sites for now.`);
      const site = await createProject(pool, text(body.name, 80) || domain, [domain], zoneOf(body.timezone), own.workspace_id);
      return json(res, 201, { site: { key: site.key, name: site.name, domains: site.domains, timezone: site.timezone } });
    }

    const match = path.match(/^\/api\/sites\/(p_[a-z0-9]{6,20})(\/[a-z]+)?$/);
    if (!match) throw new HttpError(404, "Not found.");
    const site = await mySite(r, user, match[1]);
    const action = match[2] ?? "";

    if (action === "" && method === "GET") {
      const { rows: [info] } = await pool.query(
        `select created_at, (select ts from events where project_id = $1 order by ts desc limit 1) as last_event_at from projects where id = $1`,
        [site.id],
      );
      return json(res, 200, {
        site: { key: site.key, name: site.name, domains: site.domains, timezone: site.timezone, createdAt: info.created_at, lastEventAt: info.last_event_at },
        snippet: snippet(r, site.key),
        scriptUrl: `${origin(r)}/s.js`,
      });
    }
    if (action === "" && method === "PATCH") {
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
      await pool.query("update projects set name = $2, domains = $3, timezone = $4 where id = $1", [site.id, name, domains, timezone]);
      onSiteChanged(site.key);
      return json(res, 200, { site: { key: site.key, name, domains, timezone } });
    }
    if (action === "" && method === "DELETE") {
      const body = await readJson(req);
      if (text(body.confirm, 253).toLowerCase() !== site.domains[0]) throw new HttpError(400, `Type ${site.domains[0]} to confirm.`);
      await deleteProject(pool, site.id);
      onSiteChanged(site.key);
      return json(res, 200, { ok: true });
    }
    if (action === "/check" && method === "POST") {
      if (!checks.allow(user.id)) throw new HttpError(429, "Wait a minute before checking again.");
      return json(res, 200, await checkInstall(site.domains[0], site.key));
    }
    if (action === "/stats" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://x");
      const range = url.searchParams.get("range") ?? "d30";
      return json(res, 200, await stats(pool, site, RANGE_IDS.includes(range) ? range : "d30", text(url.searchParams.get("source"), 100) || null));
    }
    if (action === "/live" && method === "GET") return json(res, 200, await live(pool, site));
    throw new HttpError(404, "Not found.");
  }

  return async function handle(r: Request) {
    const { req, res, path } = r;
    try {
      if (path.startsWith("/api/")) return await api(r);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Not allowed.");
      if (path === "/app.js") return sendAsset(r, assets.js, "public, max-age=31536000, immutable");
      if (path === "/app.css") return sendAsset(r, assets.css, "public, max-age=31536000, immutable");
      if (path === "/favicon.svg") return sendAsset(r, assets.icon, "public, max-age=86400");
      // Every other address is a page of the app, which works out what to show.
      return sendAsset(r, assets.html, "no-cache");
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error("Dashboard:", (e as Error).message);
      if (!res.headersSent) json(res, 500, { error: "Something went wrong on our side. Try again." });
    }
  };
}
