// The Statiku service: serves the website script, takes its events and the app SDKs' batches, and serves the
// dashboard (dashboard/server.ts) at every other address.
//   GET  /s.js      the script
//   POST /e         one event (a plain-text JSON body, so browsers send it without a preflight)
//   POST /v1/app    a batch of events from an app (see app.ts)
//   GET  /v1/site   what the script needs to know about its site (whether to ask for a visitor's location)
//   POST /v1/number numbers sent with a site's secret key, from anywhere (see numbers.ts); GET with ?key=&name=&value=
//   GET  /healthz   for Render; /healthz?deep=1 also asks the database, for an outside monitor
// Nothing here logs or stores an IP.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { dbConfig } from "../db/config.ts";
import type { Mailer } from "../dashboard/mail.ts";
import type { Polar } from "../dashboard/billing.ts";
import type { fetchIcon, Outbound } from "../dashboard/check.ts";
import type { Probe } from "../dashboard/monitor.ts";
import { createDashboard, type ImportApis } from "../dashboard/server.ts";
import { buildTracker } from "../tracker/build.ts";
import { collectApp, MAX_APP_BODY } from "./app.ts";
import { collect, MAX_BODY, siteConfig, type Deps } from "./collect.ts";
import { Geo } from "./geo.ts";
import { Installs } from "./installs.ts";
import { Hub } from "./live.ts";
import { MAX_NUMBERS_BODY, Numbers } from "./numbers.ts";
import { Streets, type Geocoder } from "./streets.ts";
import { Projects } from "./projects.ts";
import { Salts } from "./salts.ts";
import { Sessions } from "./sessions.ts";
import { Writer } from "./writer.ts";

export type Options = {
  // How many proxies stand in front of the service (true is one): the client is the address the outermost one saw.
  databaseUrl: string; trustProxy: boolean | number; geoPath: string | URL; cityPath?: string | URL; flushMs?: number; dashboard?: boolean;
  // Street names for shared locations; tests pass their own instead of asking OpenStreetMap.
  geocode?: Geocoder;
  // Email to the people who use the dashboard; tests keep what would be sent.
  mailer?: Mailer;
  // Where imports reach Google, GitHub and Plausible, and where billing reaches Polar; tests use stand-ins.
  imports?: ImportApis;
  polar?: Polar & { request?: Outbound };
  probe?: Probe;
  fetchIcon?: typeof fetchIcon;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

// Behind proxies (TRUST_PROXY=1 for Northflank's or Render's, 2 with Cloudflare's in front of it), each adds the
// address it saw to the end of X-Forwarded-For, so the client is that many from the end. Anything earlier in the
// header, and headers such as CF-Connecting-IP, the client could have written itself. Without a proxy: the socket.
export function clientIp(req: IncomingMessage, trustProxy: boolean | number): string {
  const proxies = trustProxy === true ? 1 : Number(trustProxy) || 0;
  if (proxies > 0) {
    const hops = String([req.headers["x-forwarded-for"]].flat()[0] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const ip = hops[hops.length - proxies] ?? hops[0];
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? "";
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Too large: answer now and let the rest drain unread.
      if (size > limit) resolve(null);
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...CORS, ...headers });
  res.end(body);
}

export async function createApp(options: Options) {
  const pool = new pg.Pool(dbConfig(options.databaseUrl, { max: 10 }));
  pool.on("error", (e) => console.error("Postgres:", e.message));
  const sessions = new Sessions(pool);
  const writer = new Writer(pool, sessions);
  const salts = new Salts(pool);
  const deps: Deps = { projects: new Projects(pool), salts, sessions, installs: new Installs(pool, salts), writer, geo: new Geo(options.geoPath, options.cityPath), hub: new Hub(), streets: new Streets(options.geocode) };

  const numbers = new Numbers(pool, writer, deps.hub);
  const script = await buildTracker();
  // The dashboard tells the ingest side when a site's domains change, so the cached copy goes at once.
  const dashboard = options.dashboard === false ? null : await createDashboard({
    pool,
    onSiteChanged: (key) => deps.projects.cache.delete(key),
    onNumbersChanged: (projectId) => numbers.forget(projectId),
    presence: (projectId) => sessions.present(projectId),
    hub: deps.hub,
    streets: deps.streets,
    mailer: options.mailer,
    imports: options.imports,
    polar: options.polar,
    probe: options.probe,
    fetchIcon: options.fetchIcon,
  });
  const etag = `"${createHash("sha256").update(script).digest("base64url").slice(0, 16)}"`;

  const ensurePartitions = () =>
    pool
      .query("select ensure_month_partitions('events', 0, 2), ensure_month_partitions('sessions', 0, 2)")
      .catch((e) => console.error("Partitions:", e.message));
  await ensurePartitions();

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/s.js" && (req.method === "GET" || req.method === "HEAD")) {
        if (req.headers["if-none-match"] === etag) return send(res, 304, "");
        // Five minutes, so a new script reaches every site soon after a deploy.
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", etag, ...CORS });
        return res.end(req.method === "HEAD" ? undefined : script);
      }
      if (path === "/e") {
        if (req.method === "OPTIONS") return send(res, 204, "");
        if (req.method !== "POST") return send(res, 405, "use POST");
        const body = await readBody(req, MAX_BODY);
        if (body === null) return send(res, 413, "body too large");
        const outcome = await collect(deps, body, String(req.headers["user-agent"] ?? ""), clientIp(req, options.trustProxy));
        return send(res, outcome.status, outcome.message);
      }
      if (path === "/v1/site" && req.method === "OPTIONS") return send(res, 204, "");
      if (path === "/v1/site" && req.method === "GET") {
        const key = new URL(req.url ?? "/", "http://x").searchParams.get("k") ?? "";
        const { cache, ...config } = await siteConfig(deps, key, String(req.headers["user-agent"] ?? ""), clientIp(req, options.trustProxy));
        return send(res, 200, JSON.stringify(config), { "content-type": "application/json", "cache-control": cache ? "public, max-age=300" : "no-store" });
      }
      if (path === "/v1/app") {
        if (req.method !== "POST") return send(res, 405, "use POST");
        const body = await readBody(req, MAX_APP_BODY);
        if (body === null) return send(res, 413, "body too large");
        const outcome = await collectApp(deps, body, clientIp(req, options.trustProxy));
        return send(res, outcome.status, outcome.message);
      }
      if (path === "/v1/number" || path === "/v1/numbers") {
        if (req.method === "OPTIONS") return send(res, 204, "");
        if (req.method !== "POST" && req.method !== "GET") return send(res, 405, "use POST");
        const body = req.method === "POST" ? await readBody(req, MAX_NUMBERS_BODY) : "";
        if (body === null) return send(res, 413, "body too large");
        const auth = req.headers.authorization ?? null;
        const outcome = await numbers.collect(auth, body, new URL(req.url ?? "/", "http://x").searchParams);
        return send(res, outcome.status, outcome.message, outcome.status === 202 ? { "content-type": "application/json" } : {});
      }
      if (path === "/healthz") {
        if (!/[?&]deep=1\b/.test(req.url ?? "")) return send(res, 200, `ok, ${writer.queue.length} queued`);
        const answered = await Promise.race([pool.query("select 1").then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
        // The asker's own country, to check that TRUST_PROXY finds visitors' addresses behind this host's proxies.
        const where = deps.geo.country(clientIp(req, options.trustProxy)) ?? "an unknown country";
        return send(res, answered ? 200 : 503, `${answered ? "ok, database answering" : "the database isn't answering"}, ${writer.queue.length} queued; you're in ${where}`);
      }
      if (!dashboard) return send(res, 404, "not found");
      // Behind Render's proxy the connection to this process is plain HTTP; the proxy says what the browser used.
      const secure = options.trustProxy ? req.headers["x-forwarded-proto"] === "https" : "encrypted" in req.socket;
      return await dashboard({ req, res, path, ip: clientIp(req, options.trustProxy), secure });
    } catch (e) {
      console.error("Request failed:", (e as Error).message);
      if (!res.headersSent) send(res, 500, "error");
    }
  });

  // Download marks only need to outlive the day an install can be matched in.
  const dropMarks = () =>
    pool.query("delete from download_marks where ts < now() - interval '48 hours'").catch((e) => console.error("Marks:", e.message));

  const timers = [
    setInterval(() => sessions.sweep(new Date()), 60_000),
    setInterval(ensurePartitions, 6 * 3600_000),
    setInterval(dropMarks, 3600_000),
  ];
  writer.start(options.flushMs ?? 1000);

  async function close() {
    for (const t of timers) clearInterval(t);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Write what is waiting; try a few times if the database is briefly away.
    for (let i = 0; i < 5; i++) {
      try {
        await writer.stop();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await pool.end();
  }

  return { server, pool, deps, writer, numbers, dropMarks, close, jobs: dashboard?.jobs };
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL");
  const app = await createApp({
    databaseUrl,
    trustProxy: Number(process.env.TRUST_PROXY) || 0,
    geoPath: process.env.GEO_DB ?? new URL("../data/country.mmdb", import.meta.url),
    cityPath: process.env.GEO_CITY_DB ?? new URL("../data/city.mmdb", import.meta.url),
  });
  const port = Number(process.env.PORT ?? 8787);
  app.server.listen(port, () => console.log(`Statiku ingest on :${port}`));
  // Render sends SIGTERM before replacing an instance: finish the batch first.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
  }
}
