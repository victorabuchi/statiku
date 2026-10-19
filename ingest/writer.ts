// Events wait in memory and are written in batches: one transaction a second (or sooner at 500 events) holds the
// events, the sessions they changed and the day's usage counts. A failed batch goes back to the front of the queue.
// This is the one place that writes events, so moving them to another store later means changing this file.
import type pg from "pg";
import type { Session, Sessions } from "./sessions.ts";

export type EventRow = {
  projectId: string;
  ts: Date;
  name: string;
  sessionId: string | null;
  visitor: string | null;
  hostname: string | null;
  path: string | null;
  source: string | null;
  referrerHost: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  props: Record<string, unknown> | null;
  revenueMinor: number | null;
  currency: string | null;
};

const BATCH = 500;
// Past this many waiting events (the database has been down a while), the oldest are dropped.
const MAX_QUEUE = 200_000;

const EVENT_COLUMNS: [string, string, (e: EventRow) => unknown][] = [
  ["project_id", "uuid", (e) => e.projectId],
  ["ts", "timestamptz", (e) => e.ts],
  ["name", "text", (e) => e.name],
  ["session_id", "bigint", (e) => e.sessionId],
  ["visitor", "bigint", (e) => e.visitor],
  ["hostname", "text", (e) => e.hostname],
  ["path", "text", (e) => e.path],
  ["source", "text", (e) => e.source],
  ["referrer_host", "text", (e) => e.referrerHost],
  ["utm_medium", "text", (e) => e.utmMedium],
  ["utm_campaign", "text", (e) => e.utmCampaign],
  ["utm_content", "text", (e) => e.utmContent],
  ["utm_term", "text", (e) => e.utmTerm],
  ["country", "text", (e) => e.country],
  ["device", "text", (e) => e.device],
  ["browser", "text", (e) => e.browser],
  ["os", "text", (e) => e.os],
  ["props", "jsonb", (e) => (e.props ? JSON.stringify(e.props) : null)],
  ["revenue_minor", "bigint", (e) => e.revenueMinor],
  ["currency", "text", (e) => e.currency],
];

const SESSION_COLUMNS: [string, string, (s: Session) => unknown][] = [
  ["project_id", "uuid", (s) => s.projectId],
  ["id", "bigint", (s) => s.id],
  ["visitor", "bigint", (s) => s.visitor],
  ["started_at", "timestamptz", (s) => s.startedAt],
  ["last_seen", "timestamptz", (s) => s.lastSeen],
  ["entry_path", "text", (s) => s.entryPath],
  ["exit_path", "text", (s) => s.exitPath],
  ["pageviews", "integer", (s) => s.pageviews],
  ["events", "integer", (s) => s.events],
  ["source", "text", (s) => s.source],
  ["referrer_host", "text", (s) => s.referrerHost],
  ["utm_medium", "text", (s) => s.utmMedium],
  ["utm_campaign", "text", (s) => s.utmCampaign],
  ["utm_content", "text", (s) => s.utmContent],
  ["utm_term", "text", (s) => s.utmTerm],
  ["country", "text", (s) => s.country],
  ["device", "text", (s) => s.device],
  ["browser", "text", (s) => s.browser],
  ["os", "text", (s) => s.os],
];

// insert … select from unnest($1::uuid[], $2::timestamptz[], …): one statement and one array per column.
function unnestInsert<T>(table: string, columns: [string, string, (row: T) => unknown][], rows: T[]) {
  const names = columns.map(([name]) => name).join(", ");
  const arrays = columns.map(([, type], i) => `$${i + 1}::${type}[]`).join(", ");
  return {
    text: `insert into ${table} (${names}) select * from unnest(${arrays})`,
    values: columns.map(([, , get]) => rows.map(get)),
  };
}

export class Writer {
  pool: pg.Pool;
  sessions: Sessions;
  queue: EventRow[] = [];
  dropped = 0;
  flushing: Promise<void> | null = null;
  timer: NodeJS.Timeout | null = null;

  constructor(pool: pg.Pool, sessions: Sessions) {
    this.pool = pool;
    this.sessions = sessions;
  }

  add(row: EventRow) {
    this.queue.push(row);
    if (this.queue.length > MAX_QUEUE) {
      const over = this.queue.length - MAX_QUEUE;
      this.queue.splice(0, over);
      this.dropped += over;
    }
    if (this.queue.length >= BATCH) this.flushQuietly();
  }

  start(intervalMs = 1000) {
    this.timer = setInterval(() => this.flushQuietly(), intervalMs);
  }

  // For timers: a failed batch is already logged and stays queued for the next try.
  flushQuietly() {
    this.flush().catch(() => {});
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  // Writes everything waiting. Only one flush runs at a time; a call during one waits for it and then runs again.
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => {});
    if (!this.queue.length && !this.sessions.anyDirty) return;
    this.flushing = this.writeAll().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async writeAll() {
    while (this.queue.length || this.sessions.anyDirty) {
      const events = this.queue.splice(0, BATCH * 4);
      const { rows: sessions, sessions: live } = this.sessions.takeDirty();
      try {
        await this.write(events, sessions);
      } catch (e) {
        // A data error (SQLSTATE class 22 or 23) would fail on every retry and block the queue, so that batch goes.
        if (/^2[23]/.test((e as { code?: string }).code ?? "")) {
          this.dropped += events.length;
          console.error(`Dropped ${events.length} events the database refused:`, (e as Error).message);
          continue;
        }
        this.sessions.requeue(live);
        this.queue.unshift(...events);
        console.error(`Writing ${events.length} events failed; they stay queued.`, (e as Error).message);
        throw e;
      }
    }
  }

  async write(events: EventRow[], sessions: Session[]) {
    const usage = new Map<string, number>();
    for (const e of events) {
      const key = `${e.projectId} ${e.ts.toISOString().slice(0, 10)}`;
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (events.length) await client.query(unnestInsert("events", EVENT_COLUMNS, events));
      if (sessions.length) {
        const insert = unnestInsert("sessions", SESSION_COLUMNS, sessions);
        await client.query({
          text: `${insert.text}
            on conflict (project_id, id, started_at) do update
               set last_seen = excluded.last_seen, exit_path = excluded.exit_path,
                   pageviews = excluded.pageviews, events = excluded.events`,
          values: insert.values,
        });
      }
      if (usage.size) {
        const keys = [...usage.keys()].map((k) => k.split(" "));
        await client.query(
          `insert into usage_daily (project_id, day, events)
           select * from unnest($1::uuid[], $2::date[], $3::bigint[])
           on conflict (project_id, day) do update set events = usage_daily.events + excluded.events`,
          [keys.map((k) => k[0]), keys.map((k) => k[1]), [...usage.values()]],
        );
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}
