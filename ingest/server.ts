// The Statiku service: serves the website script, takes its events and the app SDKs' batches, and serves the
// dashboard (dashboard/server.ts) at every other address.
//   GET  /s.js      the script
//   POST /e         one event (a plain-text JSON body, so browsers send it without a preflight)
//   POST /v1/app    a batch of events from an app (see app.ts)
//   GET  /v1/site   what the script needs to know about its site (whether to ask for a visitor's location)
//   GET  /healthz   for Render
// Nothing here logs or stores an IP.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import type { Mailer } from "../dashboard/mail.ts";
import { createDashboard } from "../dashboard/server.ts";
import { buildTracker } from "../tracker/build.ts";
import { collectApp, MAX_APP_BODY } from "./app.ts";
import { collect, MAX_BODY, siteConfig, type Deps } from "./collect.ts";
import { Geo } from "./geo.ts";
import { Installs } from "./installs.ts";
import { Hub } from "./live.ts";
import { Streets, type Geocoder } from "./streets.ts";
import { Projects } from "./projects.ts";
import { Salts } from "./salts.ts";
import { Sessions } from "./sessions.ts";
import { Writer } from "./writer.ts";

export type Options = {
  databaseUrl: string; trustProxy: boolean; geoPath: string | URL; cityPath?: string | URL; flushMs?: number; dashboard?: boolean;
  // Street names for shared locations; tests pass their own instead of asking OpenStreetMap.
  geocode?: Geocoder;
  // Email to the people who use the dashboard; tests keep what would be sent.
  mailer?: Mailer;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

// Behind Render's proxy the client is the first address it forwards; anywhere else, the socket's.
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = (name: string) => [req.headers[name]].flat()[0];
    const ip = header("cf-connecting-ip") ?? header("true-client-ip") ?? header("x-forwarded-for")?.split(",")[0];
    if (ip?.trim()) return ip.trim();
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
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  pool.on("error", (e) => console.error("Postgres:", e.message));
  const sessions = new Sessions(pool);
  const writer = new Writer(pool, sessions);
  const salts = new Salts(pool);
  const deps: Deps = { projects: new Projects(pool), salts, sessions, installs: new Installs(pool, salts), writer, geo: new Geo(options.geoPath, options.cityPath), hub: new Hub(), streets: new Streets(options.geocode) };

  const script = await buildTracker();
  // The dashboard tells the ingest side when a site's domains change, so the cached copy goes at once.
  const dashboard = options.dashboard === false ? null : await createDashboard({
    pool,
    onSiteChanged: (key) => deps.projects.cache.delete(key),
    presence: (projectId) => sessions.present(projectId),
    hub: deps.hub,
    streets: deps.streets,
    mailer: options.mailer,
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
      if (path === "/healthz") return send(res, 200, `ok, ${writer.queue.length} queued`);
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

  return { server, pool, deps, writer, dropMarks, close };
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL");
  const app = await createApp({
    databaseUrl,
    trustProxy: process.env.TRUST_PROXY === "1",
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
