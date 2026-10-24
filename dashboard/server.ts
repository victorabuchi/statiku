// The dashboard, served by the same service as the script: accounts, teams, the sites a person tracks, and their
// numbers. The pages are one app (client/), bundled when the service starts; everything it shows comes from /api.
//   GET    /  /login  /signup  /join/…  /settings  /sites/…    the app
//   POST   /api/signup  /api/login  /api/logout
//   GET    /api/me              PATCH { name?, email? }   DELETE { password }
//   POST   /api/me/password     { current, password }
//   GET    /api/me/photo        POST { image: data URL }   DELETE
//   GET    /api/team            POST /api/team/invites   DELETE /api/team/invites/:id   DELETE /api/team/members/:id
//   GET    /api/invites/:token  POST /api/invites/:token/accept
//   GET    /api/sites           every site with today's numbers     POST { address, name?, timezone? }
//   GET    /api/sites/:key      PATCH { name?, domains?, timezone? }   DELETE { confirm: domain }
//   GET    /api/sites/:key/icon    the site's own icon
//   POST   /api/sites/:key/check   is the tracking code on the site?
//   GET    /api/sites/:key/stats?range=&from=&to=&source=&country=&device=&browser=&os=&page=
//   GET    /api/sites/:key/live    who's on it right now        GET /api/sites/:key/stream   the same, pushed
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import type pg from "pg";
import type { Hub } from "../ingest/live.ts";
import { cleanDomain } from "../ingest/projects.ts";
import { createProject, deleteProject } from "../scripts/project.ts";
import {
  Attempts, changePassword, clearedCookie, cleanEmail, createUser, deleteAccount, emailLooksRight, endLogin,
  findByPassword, loginCookie, startLogin, userOf, type User,
} from "./auth.ts";
import { checkInstall, fetchIcon, imageType } from "./check.ts";
import { FILTERS, live, overview, RANGE_IDS, siteFor, stats, type Filters, type Presence, type Site } from "./stats.ts";

export type Request = { req: IncomingMessage; res: ServerResponse; path: string; ip: string; secure: boolean };

const MAX_SITES = 50;
const ICON_DAYS = 7;
const INVITE_DAYS = 7;
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

export async function createDashboard(options: { pool: pg.Pool; onSiteChanged: (key: string) => void; presence: Presence; hub: Hub }) {
  const { pool, onSiteChanged, presence, hub } = options;
  const assets = await bundle();
  const signIns = new Attempts(10, 10 * 60_000);
  const checks = new Attempts(12, 60_000);
  const passwords = new Attempts(10, 10 * 60_000);

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
      `select w.id, w.name, (select count(*) from projects p where p.workspace_id = w.id)::int as sites
         from memberships m join workspaces w on w.id = m.workspace_id
        where m.user_id = $1 and m.role = 'owner' order by m.created_at limit 1`,
      [userId],
    );
    if (!own) throw new HttpError(404, "There's no workspace for this account.");
    return own as { id: string; name: string; sites: number };
  }

  // Site icons: fetched from the site by this server, so no third party learns which sites someone tracks.
  const fetching = new Map<string, Promise<void>>();
  function refreshIcon(site: { id: string; domains: string[] }) {
    let pending = fetching.get(site.id);
    if (!pending) {
      pending = fetchIcon(site.domains[0])
        .then((icon) => pool.query("update projects set icon = $2, icon_type = $3, icon_checked_at = now() where id = $1", [site.id, icon?.data ?? null, icon?.type ?? null]))
        .then(() => {}, (e) => console.error("Icon:", (e as Error).message))
        .finally(() => fetching.delete(site.id));
      fetching.set(site.id, pending);
    }
    return pending;
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

  // The script's address, as this service is reached: the snippet points at wherever the dashboard is.
  const origin = (r: Request) => process.env.PUBLIC_URL ?? `${r.secure ? "https" : "http"}://${r.req.headers.host ?? "localhost"}`;
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
    const invitation = path.match(/^\/api\/invites\/([\w-]{20,80})(\/accept)?$/);
    if (invitation && !invitation[2] && method === "GET") {
      const found = await invite(invitation[1]);
      if (!found) throw new HttpError(404, "This invitation link isn't right. Ask for a new one.");
      return json(res, 200, { workspace: found.workspace, invitedBy: found.invited_by, valid: !found.expired && !found.used });
    }

    const user = await signedIn(r);
    if (invitation?.[2] && method === "POST") return json(res, 200, { workspace: await acceptInvite(invitation[1], user.id) });

    // ---------- Your account ----------
    if (path === "/api/me" && method === "GET") return json(res, 200, { user: me(user) });
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
    if (path === "/api/sites" && method === "GET") return json(res, 200, { sites: await overview(pool, user.id, presence) });
    if (path === "/api/sites" && method === "POST") {
      const body = await readJson(req);
      const domain = domainOf(body.address);
      if (!domain) throw new HttpError(400, "Enter your website's address, such as example.com.");
      const own = await ownWorkspace(user.id);
      if (own.sites >= MAX_SITES) throw new HttpError(400, `An account can have up to ${MAX_SITES} sites for now.`);
      const site = await createProject(pool, text(body.name, 80) || domain, [domain], zoneOf(body.timezone), own.id);
      void refreshIcon(site);
      return json(res, 201, { site: { key: site.key, name: site.name, domains: site.domains, timezone: site.timezone } });
    }

    const match = path.match(/^\/api\/sites\/(p_[a-z0-9]{6,20})(\/[a-z]+)?$/);
    if (!match) throw new HttpError(404, "Not found.");
    const site = await mySite(user, match[1]);
    const action = match[2] ?? "";

    if (action === "" && method === "GET") {
      const { rows: [info] } = await pool.query(
        `select created_at, (select ts from events where project_id = $1 order by ts desc limit 1) as last_event_at from projects where id = $1`,
        [site.id],
      );
      return json(res, 200, {
        site: { key: site.key, name: site.name, domains: site.domains, timezone: site.timezone, role: site.role, createdAt: info.created_at, lastEventAt: info.last_event_at },
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
      await pool.query("update projects set name = $2, domains = $3, timezone = $4 where id = $1", [site.id, name, domains, timezone]);
      onSiteChanged(site.key);
      if (domains[0] !== site.domains[0]) void refreshIcon({ id: site.id, domains });
      return json(res, 200, { site: { key: site.key, name, domains, timezone } });
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
      // Never looked for: wait for it (briefly). Over a week old: show the old one and look again behind it.
      if (!row.icon_checked_at) {
        await Promise.race([refreshIcon(site), new Promise((resolve) => setTimeout(resolve, 9000))]);
        row = await read();
      } else if (Date.now() - row.icon_checked_at.getTime() > ICON_DAYS * 86400_000) {
        void refreshIcon(site);
      }
      if (!row.icon) throw new HttpError(404, "No icon.");
      return image(res, row.icon_type, row.icon);
    }
    if (action === "/check" && method === "POST") {
      if (!checks.allow(user.id)) throw new HttpError(429, "Wait a minute before checking again.");
      return json(res, 200, await checkInstall(site.domains[0], site.key));
    }
    if (action === "/stats" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://x");
      const range = url.searchParams.get("range") ?? "d30";
      const filters = Object.fromEntries(FILTERS.map((f) => [f, text(url.searchParams.get(f), 300) || null])) as Filters;
      return json(res, 200, await stats(pool, site, RANGE_IDS.includes(range) ? range : "d30", filters, {
        from: url.searchParams.get("from"), to: url.searchParams.get("to"),
      }));
    }
    if (action === "/live" && method === "GET") return json(res, 200, await live(pool, site, presence(site.id)));
    if (action === "/stream" && method === "GET") {
      // Server-sent events: each event on the site as it's collected, and a nudge when someone arrives or leaves.
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", ...HEADERS });
      res.write("retry: 3000\n\n");
      const stop = hub.subscribe(site.id, (message) => res.write(`data: ${message}\n\n`));
      // A comment now and then keeps proxies from closing a quiet stream.
      const keepAlive = setInterval(() => res.write(": still here\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        stop();
      });
      return;
    }
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
