// A batch from an app SDK, from the raw body to queued rows. The IP is used here, in memory, for the country and to
// match a new install to a website download from the same network, and goes no further.
//
// The body: { project, install (a UUID the app made), platform, osVersion, appVersion, build,
//             state (free, trial, expired or licensed), events: [{ name, at, props }] }
import { cleanProps, text, type Deps, type Hit, type Outcome } from "./collect.ts";

export const MAX_APP_BODY = 64 * 1024;
const MAX_EVENTS = 100;
// Events an app kept while offline count for a week; times ahead of the server's clock are taken as now.
const MAX_AGE = 7 * 86400_000;

export const STATES = ["free", "trial", "expired", "licensed"] as const;
export type State = (typeof STATES)[number];

export type AppEvent = { name: string; at: Date; props: Hit["props"] };

export type AppBatch = {
  key: string;
  install: string;
  platform: string;
  appVersion: string | null;
  build: string | null;
  osVersion: string | null;
  state: State | null;
  events: AppEvent[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseApp(body: string, now: Date): AppBatch | string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    return "body is not JSON";
  }
  if (!data || typeof data !== "object") return "body is not an object";
  const key = text(data.project, 40);
  if (!key) return "missing project key (project)";
  const install = text(data.install, 36).toLowerCase();
  if (!UUID.test(install)) return "install must be a UUID";
  const platform = text(data.platform, 20);
  if (!platform) return "missing platform";
  if (data.state != null && !STATES.includes(data.state as State)) return `state must be one of ${STATES.join(", ")}`;
  if (!Array.isArray(data.events) || !data.events.length) return "events must be a list with at least one event";
  if (data.events.length > MAX_EVENTS) return `at most ${MAX_EVENTS} events at a time`;
  const events: AppEvent[] = [];
  for (const e of data.events as Record<string, unknown>[]) {
    const name = text(e?.name, 64);
    if (!name) return "every event needs a name";
    const at = e.at == null ? now : new Date(e.at as string | number);
    if (Number.isNaN(at.getTime())) return `${name}: at is not a time`;
    if (now.getTime() - at.getTime() > MAX_AGE) continue;
    events.push({ name, at: at > now ? now : at, props: cleanProps(e.props) });
  }
  return {
    key,
    install,
    platform,
    appVersion: text(data.appVersion, 32) || null,
    build: text(data.build, 32) || null,
    osVersion: text(data.osVersion, 32) || null,
    state: (data.state as State) ?? null,
    events,
  };
}

export async function collectApp(deps: Deps, body: string, ip: string, now = new Date()): Promise<Outcome> {
  const batch = parseApp(body, now);
  if (typeof batch === "string") return { status: 400, message: batch };
  const project = await deps.projects.byKey(batch.key);
  if (!project) return { status: 404, message: "unknown project" };
  if (!batch.events.length) return { status: 202, message: "ok" };

  const country = deps.geo.country(ip);
  // The install's source (the visit its download came from), copied onto its events as a visit's is onto its own.
  const source = await deps.installs.seen(project.id, batch, ip, country, now);
  for (const e of batch.events) {
    deps.writer.add({
      projectId: project.id,
      ts: e.at,
      name: e.name,
      sessionId: null,
      visitor: null,
      hostname: null,
      path: null,
      source: source?.source ?? null,
      referrerHost: source?.referrerHost ?? null,
      utmMedium: source?.utmMedium ?? null,
      utmCampaign: source?.utmCampaign ?? null,
      utmContent: source?.utmContent ?? null,
      utmTerm: source?.utmTerm ?? null,
      country,
      device: null,
      browser: null,
      os: batch.platform,
      props: e.props,
      revenueMinor: null,
      currency: null,
      installId: batch.install,
      appVersion: batch.appVersion,
      osVersion: batch.osVersion,
    });
  }
  return { status: 202, message: "ok" };
}
