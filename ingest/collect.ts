// One event from the website script, from the raw body to a queued row. The IP is used here, in memory, for the
// country, the visitor hash and, for downloads, the network hash an install is matched with, and goes no further.
import { agentOf, isBot } from "./agent.ts";
import type { Geo } from "./geo.ts";
import type { Installs } from "./installs.ts";
import type { Hub } from "./live.ts";
import type { Streets } from "./streets.ts";
import { hostAllowed, type Projects } from "./projects.ts";
import { hash63, networkOf, type Salts } from "./salts.ts";
import type { Sessions } from "./sessions.ts";
import { sourceOf } from "./source.ts";
import type { Writer } from "./writer.ts";

export const MAX_BODY = 8 * 1024;

export type Hit = {
  key: string;
  name: string;
  url: URL;
  referrer: string | null;
  width: number | null;
  props: Record<string, string | number | boolean> | null;
  revenue: { minor: number; currency: string } | null;
};

export type Deps = { projects: Projects; salts: Salts; sessions: Sessions; installs: Installs; writer: Writer; geo: Geo; hub: Hub; streets: Streets };

// The script's check-in from an open page and its goodbye when the page closes: they keep the live view and a
// visit's length right, and are never stored as events.
const BEAT = "_p", GONE = "_l";
// On sites that ask, the point a visitor chose to share, or their "not now". Never stored as events either.
const SHARED = "_loc", DECLINED = "_noloc";
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// What the script needs to know about its site: whether it asks visitors for their location, and whether to ask this
// visitor now (not if they've been asked already this visit). An answer of "no" is the same for everyone, so it can be
// cached; a "yes" depends on the visit.
export async function siteConfig(deps: Deps, key: string, ua: string, ip: string, now = new Date()) {
  const project = key ? await deps.projects.byKey(key) : null;
  if (!project?.askLocation || isBot(ua)) return { ask: false, prompt: false, cache: true };
  const visitor = hash63(await deps.salts.forDay(now), project.id, ip, ua);
  const session = deps.sessions.live.get(`${project.id}:${visitor}`);
  return { ask: true, prompt: !session?.asked && !session?.exact, site: project.domains[0], cache: false };
}

export type Outcome = { status: number; message: string };

// Postgres can't store NUL in text or jsonb.
export const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "";

export function cleanProps(input: unknown): Hit["props"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const props: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input).slice(0, 30)) {
    const key = text(k, 64);
    if (!key) continue;
    if (typeof v === "string") props[key] = text(v, 500);
    else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) props[key] = v;
  }
  return Object.keys(props).length ? props : null;
}

// { amount: 14.99, currency: "USD" } in the currency's smallest unit: 1499. Yen have no smaller unit, so ¥1499 stays 1499.
function cleanRevenue(input: unknown): Hit["revenue"] {
  if (!input || typeof input !== "object") return null;
  const { amount, currency } = input as { amount?: unknown; currency?: unknown };
  const code = text(currency, 3).toUpperCase();
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9 || !/^[A-Z]{3}$/.test(code)) return null;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  return { minor: Math.round(amount * 10 ** digits), currency: code };
}

// The body the script sends: { k: key, n: name, u: page URL, r: referrer, w: window width, p: props, $: revenue }.
export function parseHit(body: string): Hit | string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    return "body is not JSON";
  }
  if (!data || typeof data !== "object") return "body is not an object";
  const key = text(data.k, 40);
  if (!key) return "missing project key (k)";
  const name = text(data.n, 64);
  if (!name) return "missing event name (n)";
  let url: URL;
  try {
    url = new URL(text(data.u, 2048));
  } catch {
    return "page URL (u) is not a URL";
  }
  if (!/^https?:$/.test(url.protocol)) return "page URL (u) must be http or https";
  const width = typeof data.w === "number" && data.w > 0 && data.w < 20000 ? Math.round(data.w) : null;
  return { key, name, url, referrer: text(data.r, 2048) || null, width, props: cleanProps(data.p), revenue: cleanRevenue(data.$) };
}

export async function collect(deps: Deps, body: string, ua: string, ip: string, now = new Date()): Promise<Outcome> {
  const hit = parseHit(body);
  if (typeof hit === "string") return { status: 400, message: hit };
  const project = await deps.projects.byKey(hit.key);
  if (!project) return { status: 404, message: "unknown project" };
  if (!hostAllowed(project.domains, hit.url.hostname)) return { status: 403, message: `${hit.url.hostname} is not one of this project's domains` };
  // Bots get the same answer as everyone, so they have nothing to adjust to.
  if (isBot(ua)) return { status: 202, message: "ok" };

  const salt = await deps.salts.forDay(now);
  const visitor = hash63(salt, project.id, ip, ua);
  if (hit.name === SHARED || hit.name === DECLINED) {
    const session = project.askLocation ? await deps.sessions.beat(project.id, visitor, now, false) : null;
    if (session) {
      session.asked = true;
      const lat = Number(hit.props?.lat), lon = Number(hit.props?.lon), acc = Number(hit.props?.acc);
      if (hit.name === SHARED && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        session.exact = { lat: round4(lat), lon: round4(lon), acc: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
        deps.streets.at(session.exact.lat, session.exact.lon);
      }
      deps.hub.publish(project.id, { t: "presence" });
    }
    return { status: 202, message: "ok" };
  }
  if (hit.name === BEAT || hit.name === GONE) {
    const beating = await deps.sessions.beat(project.id, visitor, now, hit.name === GONE);
    if (beating) {
      if (beating.place === undefined) beating.place = deps.geo.place(ip);
      deps.hub.publish(project.id, { t: "presence" });
    }
    return { status: 202, message: "ok" };
  }
  const country = deps.geo.country(ip);
  const agent = agentOf(ua, hit.width);
  const path = (hit.url.pathname + hit.url.hash).slice(0, 512);
  const pageview = hit.name === "pageview";
  const session = await deps.sessions.touch(project.id, visitor, now, path, pageview, () => ({
    ...sourceOf(hit.url, hit.referrer),
    entryPath: path,
    country,
    ...agent,
  }));
  // The city for the live globe, looked up once a visit (again after a restart, as it's never saved).
  if (session.place === undefined) session.place = deps.geo.place(ip);

  deps.writer.add({
    projectId: project.id,
    ts: now,
    name: hit.name,
    sessionId: session.id,
    visitor,
    hostname: hit.url.hostname.toLowerCase().slice(0, 253),
    path,
    source: session.source,
    referrerHost: session.referrerHost,
    utmMedium: session.utmMedium,
    utmCampaign: session.utmCampaign,
    utmContent: session.utmContent,
    utmTerm: session.utmTerm,
    country,
    ...agent,
    props: hit.props,
    revenueMinor: hit.revenue?.minor ?? null,
    currency: hit.revenue?.currency ?? null,
    installId: null,
    appVersion: null,
    osVersion: null,
  });
  deps.hub.publish(project.id, {
    t: "event",
    e: {
      ts: now, name: hit.name, path, country, source: session.source, device: agent.device, browser: agent.browser, os: agent.os, app: false,
      city: session.place?.city ?? null, revenue: hit.revenue, first: session.events === 1,
    },
  });
  if (hit.name === "download") {
    deps.writer.addMark({
      projectId: project.id,
      network: hash63(salt, project.id, networkOf(ip)),
      ts: now,
      sessionId: session.id,
      source: session.source,
      referrerHost: session.referrerHost,
      utmMedium: session.utmMedium,
      utmCampaign: session.utmCampaign,
      utmContent: session.utmContent,
      utmTerm: session.utmTerm,
    });
  }
  return { status: 202, message: "ok" };
}
