// Installs. The first batch from an install creates its row and, when a website download came from the same network
// in the day before, takes that download's mark: the install is credited to the visit and source it came from. This
// is an estimate (another Mac on the network could have downloaded it), and the dashboard says so. Every batch after
// that updates the install's versions, state and last seen.
import type pg from "pg";
import type { AppBatch } from "./app.ts";
import { hash63, networkOf, type Salts } from "./salts.ts";
import type { Source } from "./source.ts";

export const MATCH_WINDOW = 24 * 3600_000;

export type Matched = Source & { sessionId: string };

const SOURCE_COLUMNS = "session_id::text, source, referrer_host, utm_medium, utm_campaign, utm_content, utm_term";

const matched = (r: Record<string, string | null> | undefined): Matched | null =>
  r?.source
    ? {
        sessionId: r.session_id!, source: r.source, referrerHost: r.referrer_host, utmMedium: r.utm_medium,
        utmCampaign: r.utm_campaign, utmContent: r.utm_content, utmTerm: r.utm_term,
      }
    : null;

export class Installs {
  pool: pg.Pool;
  salts: Salts;

  constructor(pool: pg.Pool, salts: Salts) {
    this.pool = pool;
    this.salts = salts;
  }

  // Records the batch on its install and returns the install's source, or null when it wasn't matched to a visit.
  async seen(projectId: string, batch: AppBatch, ip: string, country: string | null, now: Date): Promise<Matched | null> {
    const times = batch.events.map((e) => e.at.getTime());
    const first = new Date(Math.min(...times)), last = new Date(Math.max(...times));
    const details = [
      batch.platform, batch.appVersion, batch.build, batch.osVersion, batch.state,
      batch.state === "trial" ? last : null, batch.state === "licensed" ? last : null, country,
    ];
    const { rows: [known] } = await this.pool.query(
      `update installs
          set last_seen = greatest(last_seen, $3), platform = $4, app_version = coalesce($5, app_version),
              build = coalesce($6, build), os_version = coalesce($7, os_version), state = coalesce($8, state),
              trial_at = coalesce(trial_at, $9), licensed_at = coalesce(licensed_at, $10), country = coalesce($11, country)
        where project_id = $1 and id = $2
        returning ${SOURCE_COLUMNS}`,
      [projectId, batch.install, last, ...details],
    );
    if (known) return matched(known);

    // A new install: look for a download from its network with today's salt and yesterday's, since a download late
    // in the evening may be installed after midnight.
    const keys = [await this.salts.forDay(now), await this.salts.dayBefore(now)].filter((k) => k !== null);
    const networks = keys.map((k) => hash63(k, projectId, networkOf(ip)));
    const client = await this.pool.connect();
    let mark: Record<string, string | null> | undefined;
    let created = false;
    try {
      await client.query("begin");
      // The latest download not already taken by another install; skip locked so two installs never share one.
      ({ rows: [mark] } = await client.query(
        `select id, ${SOURCE_COLUMNS} from download_marks
          where project_id = $1 and network = any($2::bigint[]) and ts > $3 and ts <= $4 and install_id is null
          order by ts desc limit 1
          for update skip locked`,
        [projectId, networks, new Date(now.getTime() - MATCH_WINDOW), now],
      ));
      const { rowCount } = await client.query(
        `insert into installs (project_id, id, first_seen, last_seen, platform, app_version, build, os_version, state,
                               trial_at, licensed_at, country, session_id, source, referrer_host, utm_medium,
                               utm_campaign, utm_content, utm_term)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         on conflict (project_id, id) do nothing`,
        [
          projectId, batch.install, first, last, ...details, mark?.session_id ?? null, mark?.source ?? null,
          mark?.referrer_host ?? null, mark?.utm_medium ?? null, mark?.utm_campaign ?? null, mark?.utm_content ?? null,
          mark?.utm_term ?? null,
        ],
      );
      created = rowCount === 1;
      if (created && mark) await client.query("update download_marks set install_id = $2 where id = $1", [mark.id, batch.install]);
      await client.query(created ? "commit" : "rollback");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Another batch from the same install created it meanwhile: the mark stays free and that row is updated instead.
    return created ? matched(mark) : this.seen(projectId, batch, ip, country, now);
  }
}
