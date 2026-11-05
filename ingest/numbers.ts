// Trackers: anything a site sends from anywhere (a script, a server, a phone, a sensor), with its secret key:
//
//   curl https://<statiku host>/v1/track -H "Authorization: Bearer sn_…" -d '{"name": "Home goals", "value": 2}'
//
// A value is a number, a word or a yes/no ("Online", "Sunny", true). The key can also come as ?key=, and a value as
// ?name=&value=, for devices that can only open an address. A body may hold one value, a list of them, or
// { "values": [...] } (or "numbers"); each can have a time ("ts", ISO or Unix seconds) and "op": "add" for a number
// that counts up (installs, sales), where each value is added to the total. Any other number keeps its latest value
// (a score, a temperature), and so do words. A tracker's kind is set by its first value. (/v1/number is the same.)
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

export type Kind = "set" | "add" | "text";
export type NumberPoint = { name: string; value: number | null; text: string | null; ts: Date; op: "set" | "add" | null };

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

// A number (from a number or a numeric string), or a word (any other text, or a yes/no).
export const valueOf = (input: unknown): { value: number; text: null } | { value: null; text: string } | null => {
  if (typeof input === "boolean") return { value: null, text: input ? "Yes" : "No" };
  const raw = typeof input === "string" ? input.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : null;
  const n = typeof input === "number" ? input : raw && /^-?[\d\s]*[.,]?\d+(e-?\d+)?$/i.test(raw) ? Number(raw.replace(/\s/g, "").replace(",", ".")) : NaN;
  if (Number.isFinite(n) && Math.abs(n) < 1e15) return { value: n, text: null };
  if (raw) return { value: null, text: raw.slice(0, 200) };
  return null;
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
    const list = data && typeof data === "object" ? ((data as { values?: unknown }).values ?? (data as { numbers?: unknown }).numbers) : undefined;
    items = Array.isArray(data) ? data : Array.isArray(list) ? list : [data];
  } else if (query.has("name")) {
    items = [{ name: query.get("name"), value: query.get("value"), ts: query.get("ts"), op: query.get("op") }];
  } else return 'send a value: {"name": "…", "value": 1}';
  if (!items.length) return "no values in the body";
  if (items.length > PER_CALL) return `at most ${PER_CALL} values a call`;
  const points: NumberPoint[] = [];
  for (const [i, item] of items.entries()) {
    const at = items.length > 1 ? ` (number ${i + 1})` : "";
    if (!item || typeof item !== "object") return `each value is an object with a name and a value${at}`;
    const { name: rawName, value: rawValue, ts: rawTs, op: rawOp } = item as Record<string, unknown>;
    const name = nameOf(rawName);
    if (!name) return `missing name${at}`;
    const value = valueOf(rawValue);
    if (value === null) return `"${name}" needs a value: a number, a word or a yes/no${at}`;
    // Values sent together without a time keep their order, a millisecond apart.
    const ts = timeOf(rawTs, new Date(now.getTime() + i));
    if (!ts) return `"${name}" has a time that isn't one (ISO, or Unix seconds), or is in the future${at}`;
    const op = rawOp === "add" || rawOp === "set" ? rawOp : null;
    if (op === "add" && value.text !== null) return `"${name}" counts up, so its values must be numbers${at}`;
    points.push({ name, ...value, ts, op });
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
    if (!key) return { status: 401, message: "send the site's tracker key, as Authorization: Bearer sn_… (from Add tracker in Statiku)" };
    const projectId = await this.siteOf(key);
    if (!projectId) return { status: 401, message: "that tracker key isn't one of a site's (a new key replaces the old one)" };
    const points = parseNumbers(body, query, now);
    if (typeof points === "string") return { status: 400, message: points };

    const minute = Math.floor(now.getTime() / 60_000);
    const used = this.minutes.get(projectId);
    const count = used?.minute === minute ? used.count : 0;
    if (count + points.length > PER_MINUTE) return { status: 429, message: `at most ${PER_MINUTE} values a minute` };
    if (this.minutes.size > 10_000) this.minutes.clear();
    this.minutes.set(projectId, { minute, count: count + points.length });

    const kinds = await this.kindsOf(projectId);
    // A new tracker's kind is the one its first value asks for: words make a word tracker.
    const firsts = new Map<string, Kind>();
    for (const p of points) if (!kinds.has(p.name) && !firsts.has(p.name)) firsts.set(p.name, p.text !== null ? "text" : p.op ?? "set");
    const fresh = [...firsts.entries()];
    // A tracker of numbers takes only numbers; a tracker of words takes numbers too, as words.
    const wrong = points.find((p) => p.text !== null && (kinds.get(p.name) ?? firsts.get(p.name)) !== "text");
    if (wrong) return { status: 400, message: `"${wrong.name}" tracks numbers, so "${wrong.text}" can't be one of its values` };
    if (fresh.length) {
      if (kinds.size + fresh.length > NAMES_PER_SITE) return { status: 400, message: `a site can have up to ${NAMES_PER_SITE} trackers; delete some on the Trackers page` };
      await this.pool.query(
        "insert into metrics (project_id, name, kind) select $1, * from unnest($2::text[], $3::text[]) on conflict do nothing",
        [projectId, fresh.map(([name]) => name), fresh.map(([, kind]) => kind)],
      );
      this.kinds.delete(projectId);
      for (const [name, kind] of fresh) kinds.set(name, kind);
    }
    for (const p of points) {
      const kind = kinds.get(p.name) ?? "set";
      const text = kind === "text" ? p.text ?? String(p.value) : null;
      this.writer.addRow("metric_points", { project_id: projectId, name: p.name, ts: p.ts, value: text === null ? p.value : null, text_value: text });
      this.hub.publish(projectId, { t: "number", n: { name: p.name, value: text ?? p.value!, ts: p.ts, kind } });
    }
    return { status: 202, message: JSON.stringify({ ok: true, saved: points.length }) };
  }
}
