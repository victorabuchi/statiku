// Numbers a site sends from anywhere (a script, a server, a phone, a sensor), with its secret key:
//
//   curl https://<statiku host>/v1/number -H "Authorization: Bearer sn_…" -d '{"name": "Home goals", "value": 2}'
//
// The key can also come as ?key=, and a number as ?name=&value=, for devices that can only open an address. A body may
// hold one number, a list of them, or { "numbers": [...] }; each can have a time ("ts", ISO or Unix seconds) and
// "op": "add" for a number that counts up (installs, sales), where each value is added to the total. Any other number
// keeps its latest value (a score, a temperature). A number's kind is set by its first value.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { Hub } from "./live.ts";
import type { Writer } from "./writer.ts";

export const MAX_NUMBERS_BODY = 64 * 1024;
const PER_CALL = 100;
const NAMES_PER_SITE = 500;
// Per site, a minute's worth of numbers; more is refused until the minute is over.
const PER_MINUTE = 1200;
const TTL = 60_000;

export type Kind = "set" | "add";
export type NumberPoint = { name: string; value: number; ts: Date; op: Kind | null };

export const newNumbersKey = () => `sn_${randomBytes(24).toString("base64url")}`;
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

// A number's name as stored: printable, trimmed, at most 64 characters.
export function nameOf(input: unknown): string {
  return typeof input === "string" ? input.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 64) : "";
}

// ISO text, or Unix time in seconds or milliseconds; from 2000 to an hour from now.
export function timeOf(input: unknown, now: Date): Date | null {
  if (input == null || input === "") return now;
  const n = typeof input === "number" ? input : typeof input === "string" && /^\d+(\.\d+)?$/.test(input.trim()) ? Number(input) : NaN;
  const at = Number.isFinite(n) ? new Date(n < 1e11 ? n * 1000 : n) : typeof input === "string" ? new Date(input) : new Date(NaN);
  const t = at.getTime();
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > now.getTime() + 3600_000) return null;
  return at;
}

const valueOf = (input: unknown) => {
  const n = typeof input === "number" ? input : typeof input === "string" && input.trim() ? Number(input.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n : null;
};

// One call's numbers, or why they can't be taken.
export function parseNumbers(body: string, query: URLSearchParams, now = new Date()): NumberPoint[] | string {
  let items: unknown[];
  if (body.trim()) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return "the body is not JSON";
    }
    items = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { numbers?: unknown }).numbers) ? (data as { numbers: unknown[] }).numbers : [data];
  } else if (query.has("name")) {
    items = [{ name: query.get("name"), value: query.get("value"), ts: query.get("ts"), op: query.get("op") }];
  } else return 'send a number: {"name": "…", "value": 1}';
  if (!items.length) return "no numbers in the body";
  if (items.length > PER_CALL) return `at most ${PER_CALL} numbers a call`;
  const points: NumberPoint[] = [];
  for (const [i, item] of items.entries()) {
    const at = items.length > 1 ? ` (number ${i + 1})` : "";
    if (!item || typeof item !== "object") return `each number is an object with a name and a value${at}`;
    const { name: rawName, value: rawValue, ts: rawTs, op: rawOp } = item as Record<string, unknown>;
    const name = nameOf(rawName);
    if (!name) return `missing name${at}`;
    const value = valueOf(rawValue);
    if (value === null) return `"${name}" needs a number as its value${at}`;
    const ts = timeOf(rawTs, now);
    if (!ts) return `"${name}" has a time that isn't one (ISO, or Unix seconds), or is in the future${at}`;
    const op = rawOp === "add" || rawOp === "set" ? rawOp : null;
    points.push({ name, value, ts, op });
  }
  return points;
}

export class Numbers {
  pool: pg.Pool;
  writer: Writer;
  hub: Hub;
  // Keys by their hash, and each site's numbers' kinds, cached for a minute.
  keys = new Map<string, { projectId: string | null; at: number }>();
  kinds = new Map<string, { kinds: Map<string, Kind>; at: number }>();
  minutes = new Map<string, { minute: number; count: number }>();

  constructor(pool: pg.Pool, writer: Writer, hub: Hub) {
    this.pool = pool;
    this.writer = writer;
    this.hub = hub;
  }

  async siteOf(key: string, now = Date.now()) {
    const hash = hashKey(key);
    const hit = this.keys.get(hash);
    if (hit && now - hit.at < TTL) return hit.projectId;
    const { rows: [row] } = await this.pool.query("select id from projects where numbers_key_hash = $1", [hash]);
    if (this.keys.size > 10_000) this.keys.clear();
    this.keys.set(hash, { projectId: row?.id ?? null, at: now });
    return row?.id ?? null;
  }

  // A site's numbers and their kinds; a new name is added with the kind its first value asks for.
  async kindsOf(projectId: string, now = Date.now()) {
    const hit = this.kinds.get(projectId);
    if (hit && now - hit.at < TTL) return hit.kinds;
    const { rows } = await this.pool.query("select name, kind from metrics where project_id = $1", [projectId]);
    const kinds = new Map<string, Kind>(rows.map((r) => [r.name, r.kind]));
    this.kinds.set(projectId, { kinds, at: now });
    return kinds;
  }

  forget(projectId: string) {
    this.kinds.delete(projectId);
    for (const [hash, hit] of this.keys) if (hit.projectId === projectId) this.keys.delete(hash);
  }

  async collect(auth: string | null, body: string, query: URLSearchParams, now = new Date()): Promise<{ status: number; message: string }> {
    const key = (auth?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? query.get("key") ?? "").trim();
    if (!key) return { status: 401, message: "send the site's numbers key, as Authorization: Bearer sn_… (from the site's Numbers page)" };
    const projectId = await this.siteOf(key);
    if (!projectId) return { status: 401, message: "that numbers key isn't one of a site's (a new key replaces the old one)" };
    const points = parseNumbers(body, query, now);
    if (typeof points === "string") return { status: 400, message: points };

    const minute = Math.floor(now.getTime() / 60_000);
    const used = this.minutes.get(projectId);
    const count = used?.minute === minute ? used.count : 0;
    if (count + points.length > PER_MINUTE) return { status: 429, message: `at most ${PER_MINUTE} numbers a minute` };
    if (this.minutes.size > 10_000) this.minutes.clear();
    this.minutes.set(projectId, { minute, count: count + points.length });

    const kinds = await this.kindsOf(projectId);
    // A new number's kind is the one its first value asks for.
    const firsts = new Map<string, Kind>();
    for (const p of points) if (!kinds.has(p.name) && !firsts.has(p.name)) firsts.set(p.name, p.op ?? "set");
    const fresh = [...firsts.entries()];
    if (fresh.length) {
      if (kinds.size + fresh.length > NAMES_PER_SITE) return { status: 400, message: `a site can have up to ${NAMES_PER_SITE} numbers; delete some on its Numbers page` };
      await this.pool.query(
        "insert into metrics (project_id, name, kind) select $1, * from unnest($2::text[], $3::text[]) on conflict do nothing",
        [projectId, fresh.map(([name]) => name), fresh.map(([, kind]) => kind)],
      );
      this.kinds.delete(projectId);
      for (const [name, kind] of fresh) kinds.set(name, kind);
    }
    for (const p of points) {
      this.writer.addRow("metric_points", { project_id: projectId, name: p.name, ts: p.ts, value: p.value });
      this.hub.publish(projectId, { t: "number", n: { name: p.name, value: p.value, ts: p.ts, kind: kinds.get(p.name) ?? "set" } });
    }
    return { status: 202, message: JSON.stringify({ ok: true, saved: points.length }) };
  }
}
