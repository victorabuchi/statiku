// Events wait in memory and are written in batches: one transaction a second (or sooner at 500 events) holds the
// events, the sessions they changed, the download marks and the day's usage counts. A failed batch goes back to the
// front of the queue.
// This is the one place that writes events, so moving them to another store later means changing this file.
import type pg from "pg";
import type { Session, Sessions } from "./sessions.ts";
import type { Source } from "./source.ts";

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
  installId: string | null;
  appVersion: string | null;
  osVersion: string | null;
};

export type MarkRow = Source & { projectId: string; network: string; ts: Date; sessionId: string };

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
  ["install_id", "uuid", (e) => e.installId],
  ["app_version", "text", (e) => e.appVersion],
  ["os_version", "text", (e) => e.osVersion],
];

const MARK_COLUMNS: [string, string, (m: MarkRow) => unknown][] = [
  ["project_id", "uuid", (m) => m.projectId],
  ["network", "bigint", (m) => m.network],
  ["ts", "timestamptz", (m) => m.ts],
  ["session_id", "bigint", (m) => m.sessionId],
  ["source", "text", (m) => m.source],
  ["referrer_host", "text", (m) => m.referrerHost],
  ["utm_medium", "text", (m) => m.utmMedium],
  ["utm_campaign", "text", (m) => m.utmCampaign],
  ["utm_content", "text", (m) => m.utmContent],
  ["utm_term", "text", (m) => m.utmTerm],
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

// The tables beside events, written in the same batches: numbers sent with a site's key, clicks and scroll depths for
// heatmaps, and page speed and errors. Rows are keyed by column name. Only numbers count towards a site's events.
export const EXTRA = {
  metric_points: { project_id: "uuid", name: "text", ts: "timestamptz", value: "float8", text_value: "text", props: "jsonb" },
  clicks: { project_id: "uuid", ts: "timestamptz", path: "text", device: "text", x: "real", y: "integer", page_h: "integer", target: "text" },
  scrolls: { project_id: "uuid", ts: "timestamptz", path: "text", device: "text", depth: "smallint" },
  vitals: { project_id: "uuid", ts: "timestamptz", path: "text", device: "text", lcp: "integer", inp: "integer", cls: "real", ttfb: "integer", status: "smallint" },
  page_errors: { project_id: "uuid", ts: "timestamptz", path: "text", message: "text", source: "text", line: "integer", browser: "text" },
} as const;
export type ExtraTable = keyof typeof EXTRA;
export type ExtraRow = Record<string, unknown> & { project_id: string; ts: Date };
const extraColumns = (table: ExtraTable): [string, string, (row: ExtraRow) => unknown][] =>
  Object.entries(EXTRA[table]).map(([column, type]) => [column, type, (row) => row[column] ?? null]);

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
  marks: MarkRow[] = [];
  extras: [ExtraTable, ExtraRow][] = [];
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

  addMark(row: MarkRow) {
    this.marks.push(row);
  }

  addRow(table: ExtraTable, row: ExtraRow) {
    this.extras.push([table, row]);
    // Like events: past the limit (the database has been down a while), the oldest go.
    if (this.extras.length > MAX_QUEUE) this.extras.splice(0, this.extras.length - MAX_QUEUE);
    if (this.extras.length >= BATCH * 4) this.flushQuietly();
  }

  get waiting() {
    return this.queue.length || this.marks.length || this.extras.length || this.sessions.anyDirty;
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
    if (!this.waiting) return;
    this.flushing = this.writeAll().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async writeAll() {
    while (this.waiting) {
      const events = this.queue.splice(0, BATCH * 4);
      const marks = this.marks.splice(0);
      const extras = this.extras.splice(0, BATCH * 8);
      const { rows: sessions, sessions: live } = this.sessions.takeDirty();
      try {
        await this.write(events, sessions, marks, extras);
      } catch (e) {
        // A data error (SQLSTATE class 22 or 23) would fail on every retry and block the queue, so that batch goes.
        if (/^2[23]/.test((e as { code?: string }).code ?? "")) {
          this.dropped += events.length;
          console.error(`Dropped ${events.length} events the database refused:`, (e as Error).message);
          continue;
        }
        this.sessions.requeue(live);
        this.marks.unshift(...marks);
        this.extras.unshift(...extras);
        this.queue.unshift(...events);
        console.error(`Writing ${events.length} events failed; they stay queued.`, (e as Error).message);
        throw e;
      }
    }
  }

  async write(events: EventRow[], sessions: Session[], marks: MarkRow[], extras: [ExtraTable, ExtraRow][] = []) {
    const usage = new Map<string, number>();
    const count = (projectId: string, ts: Date) => {
      const key = `${projectId} ${ts.toISOString().slice(0, 10)}`;
      usage.set(key, (usage.get(key) ?? 0) + 1);
    };
    for (const e of events) count(e.projectId, e.ts);
    const byTable = new Map<ExtraTable, ExtraRow[]>();
    for (const [table, row] of extras) {
      const list = byTable.get(table);
      if (list) list.push(row);
      else byTable.set(table, [row]);
      if (table === "metric_points") count(row.project_id, row.ts);
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
      if (marks.length) await client.query(unnestInsert("download_marks", MARK_COLUMNS, marks));
      for (const [table, rows] of byTable) await client.query(unnestInsert(table, extraColumns(table), rows));
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
