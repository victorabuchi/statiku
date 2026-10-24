// Live sessions: a visitor's events with gaps under 30 minutes. They are kept in memory and written with each batch.
// After a restart, a visitor's open session is found again in the database.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Place } from "./geo.ts";
import type { Source } from "./source.ts";

export const SESSION_GAP = 30 * 60_000;
// On the site right now: seen in the last 90 seconds (an open page checks in every 30) and not gone.
export const PRESENT_MS = 90_000;

export type Session = Source & {
  projectId: string;
  id: string;
  visitor: string;
  startedAt: Date;
  lastSeen: Date;
  entryPath: string;
  exitPath: string;
  pageviews: number;
  events: number;
  country: string | null;
  device: string;
  browser: string;
  os: string;
  dirty: boolean;
  // The page was closed (kept in memory only; the next event or check-in brings the visitor back).
  left?: boolean;
  // The approximate city, for the live globe. Memory only: it isn't one of the columns written.
  place?: Place | null;
};

// What a new session starts with: the first event's source, page and visitor details.
export type SessionStart = Omit<Session, "projectId" | "id" | "visitor" | "startedAt" | "lastSeen" | "exitPath" | "pageviews" | "events" | "dirty">;

const MASK = (1n << 63n) - 1n;
const newId = () => (randomBytes(8).readBigUInt64BE(0) & MASK).toString();
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export class Sessions {
  pool: pg.Pool;
  live = new Map<string, Session>();
  // Sessions replaced by a newer one before their last changes were written.
  ended: Session[] = [];
  lookups = new Map<string, Promise<Session | null>>();

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // The visitor's latest session, from memory or, after a restart, the database.
  async latest(projectId: string, visitor: string, now: Date): Promise<Session | undefined> {
    const key = `${projectId}:${visitor}`;
    const session = this.live.get(key);
    if (session) return session;
    let lookup = this.lookups.get(key);
    if (!lookup) {
      lookup = this.find(projectId, visitor, now).finally(() => this.lookups.delete(key));
      this.lookups.set(key, lookup);
    }
    const found = await lookup;
    // Another event from the same visitor may have started a session while this one waited.
    return this.live.get(key) ?? found ?? undefined;
  }

  // The visitor's open session, counting this event, or a new one when there is none.
  async touch(projectId: string, visitor: string, now: Date, path: string, pageview: boolean, start: () => SessionStart): Promise<Session> {
    const key = `${projectId}:${visitor}`;
    let session = await this.latest(projectId, visitor, now);
    if (!session || now.getTime() - session.lastSeen.getTime() > SESSION_GAP) {
      if (session?.dirty) this.ended.push(session);
      const s = start();
      session = { ...s, projectId, id: newId(), visitor, startedAt: now, lastSeen: now, exitPath: s.entryPath, pageviews: 0, events: 0, dirty: true };
    }
    this.live.set(key, session);
    session.lastSeen = now;
    session.left = false;
    session.events += 1;
    if (pageview) {
      session.pageviews += 1;
      session.exitPath = path;
    }
    session.dirty = true;
    return session;
  }

  // A check-in from an open page, or its closing: the visit goes on (its length grows) without counting as an event.
  // Only a visit that's still open continues; a check-in never starts one.
  async beat(projectId: string, visitor: string, now: Date, gone: boolean): Promise<Session | null> {
    const session = await this.latest(projectId, visitor, now);
    if (!session || now.getTime() - session.lastSeen.getTime() > SESSION_GAP) return null;
    this.live.set(`${projectId}:${visitor}`, session);
    if (now > session.lastSeen) session.lastSeen = now;
    session.left = gone;
    session.dirty = true;
    return session;
  }

  // The site's visitors right now.
  present(projectId: string, now = new Date()): Session[] {
    const here: Session[] = [];
    for (const s of this.live.values()) {
      if (s.projectId === projectId && !s.left && now.getTime() - s.lastSeen.getTime() < PRESENT_MS) here.push(s);
    }
    return here;
  }

  // The visitor hash changes every UTC day, so an open session can only have started today.
  async find(projectId: string, visitor: string, now: Date): Promise<Session | null> {
    const { rows } = await this.pool.query(
      `select id::text, started_at, last_seen, entry_path, exit_path, pageviews, events, source, referrer_host, utm_medium,
              utm_campaign, utm_content, utm_term, country, device, browser, os
         from sessions
        where project_id = $1 and visitor = $2 and started_at >= $3 and last_seen > $4
        order by last_seen desc limit 1`,
      [projectId, visitor, startOfUtcDay(now), new Date(now.getTime() - SESSION_GAP)],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      projectId, id: r.id, visitor, startedAt: r.started_at, lastSeen: r.last_seen, entryPath: r.entry_path, exitPath: r.exit_path,
      pageviews: r.pageviews, events: r.events, source: r.source, referrerHost: r.referrer_host, utmMedium: r.utm_medium,
      utmCampaign: r.utm_campaign, utmContent: r.utm_content, utmTerm: r.utm_term, country: r.country, device: r.device,
      browser: r.browser, os: r.os, dirty: false,
    };
  }

  // Sessions changed since the last batch, as copies to write, and the sessions themselves to mark again on failure.
  takeDirty(): { rows: Session[]; sessions: Session[] } {
    const sessions = [...this.ended.splice(0), ...this.live.values()].filter((s) => s.dirty);
    for (const s of sessions) s.dirty = false;
    return { rows: sessions.map((s) => ({ ...s })), sessions };
  }

  // After a failed write: mark them for the next batch, keeping ended ones that are no longer live.
  requeue(sessions: Session[]) {
    for (const s of sessions) {
      s.dirty = true;
      if (this.live.get(`${s.projectId}:${s.visitor}`) !== s) this.ended.push(s);
    }
  }

  get anyDirty(): boolean {
    return this.ended.length > 0 || [...this.live.values()].some((s) => s.dirty);
  }

  // Forget sessions that have ended and are written.
  sweep(now: Date) {
    for (const [key, s] of this.live) {
      if (!s.dirty && now.getTime() - s.lastSeen.getTime() > SESSION_GAP) this.live.delete(key);
    }
  }
}
