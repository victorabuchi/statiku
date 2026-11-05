// Watching the sites Statiku counts, for their owners, every few minutes.
//  - Gone quiet: a site that usually has visitors at this hour of the week but has had no events for an hour is
//    looked at: is it down, has Statiku's code gone from it, or is it just quiet? Its owners get one email, and one
//    more when visits come back.
//  - A rush: many times the usual page views in a quarter of an hour, mostly from one source. Someone just linked to
//    the site; the email says who, while it's still happening. At most one every six hours.
import type pg from "pg";
import { fetchPublic } from "./check.ts";
import { letter, type Mailer } from "./mail.ts";

export type Probe = (domain: string) => Promise<{ status: number; html: string } | { error: string }>;

const probePublic: Probe = async (domain) => {
  try {
    const res = await fetchPublic(new URL(`https://${domain}/`));
    return { status: res.status, html: res.body.toString("utf8") };
  } catch (e) {
    return { error: (e as { code?: string }).code ?? (e as Error).message };
  }
};

// The usual page views in the hour before now, from the same hour on each of the last four weeks, in hours so that a
// daylight saving change doesn't move the window.
const WATCHED = `
  select p.id, p.key, p.name, p.domains, p.alert_kind as kind, p.alert_since as since, p.alert_quiet as quiet, p.alert_surge as surge, p.surge_at,
         (select count(*) from events e where e.project_id = p.id and e.ts > $1::timestamptz - interval '1 hour' and e.ts <= $1)::int as last_hour,
         (select count(*) from events e where e.project_id = p.id and e.name = 'pageview' and e.ts > $1::timestamptz - interval '15 minutes' and e.ts <= $1)::int as last_quarter,
         (select sum((select count(*) from events e where e.project_id = p.id and e.name = 'pageview'
                        and e.ts > $1::timestamptz - make_interval(hours => 168 * w + 1) and e.ts <= $1::timestamptz - make_interval(hours => 168 * w)))
            from generate_series(1, 4) w)::float / 4 as usual_hour
    from projects p
   where (p.alert_quiet or p.alert_surge or p.alert_kind is not null)
     and exists (select 1 from events e where e.project_id = p.id and e.ts > $1::timestamptz - interval '28 days')`;

export function createMonitor(o: { pool: pg.Pool; mailer: Mailer; origin: () => string; probe?: Probe }) {
  const { pool, mailer } = o;
  const probe = o.probe ?? probePublic;

  async function tellOwners(site: { id: string }, subject: string, body: Parameters<typeof letter>[0]) {
    const { rows } = await pool.query(
      `select u.email from projects p join memberships m on m.workspace_id = p.workspace_id and m.role = 'owner' join users u on u.id = m.user_id where p.id = $1`,
      [site.id],
    );
    for (const { email } of rows) await mailer({ to: email, subject, ...letter(body) }).catch((e) => console.error("Alert email:", (e as Error).message));
  }

  async function watch(now = new Date()) {
    const { rows } = await pool.query(WATCHED, [now]);
    for (const site of rows) {
      const domain = site.domains[0];
      const live = `${o.origin()}/sites/${site.key}/live`;
      // Back: visits came in again after an alert.
      if (site.kind && site.last_hour > 0) {
        await pool.query("update projects set alert_kind = null, alert_since = null where id = $1", [site.id]);
        const minutes = Math.round((now.getTime() - new Date(site.since).getTime()) / 60_000);
        await tellOwners(site, `Visits are back on ${domain}`, {
          heading: `Visits are back on ${domain}`,
          lines: [`Statiku is counting visits on ${domain} again, ${minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`} after they stopped.`],
          button: { label: "Open the live view", url: live },
        });
        continue;
      }
      // Gone quiet: an hour without a single event, when the same hour usually brings ten page views or more.
      if (!site.kind && site.quiet && site.last_hour === 0 && site.usual_hour >= 10) {
        const seen = await probe(domain);
        const kind = "error" in seen || seen.status >= 500 ? "down" : seen.status < 400 && !seen.html.includes(site.key) ? "missing" : "quiet";
        await pool.query("update projects set alert_kind = $2, alert_since = $3 where id = $1", [site.id, kind, now]);
        const usual = Math.round(site.usual_hour);
        const lines = {
          down: [`${domain} isn't answering: ${"error" in seen ? `it couldn't be reached (${seen.error})` : `it answers with an error (${seen.status})`}.`, `Statiku has counted no visits for an hour; at this time of the week it usually counts about ${usual} page views an hour.`],
          missing: [`${domain} answers, but Statiku's code isn't on its home page any more, so no visits have been counted for an hour.`, `At this time of the week it usually counts about ${usual} page views an hour. Was the site's theme or layout changed recently?`],
          quiet: [`Statiku has counted no visits on ${domain} for an hour; at this time of the week it usually counts about ${usual} page views an hour.`, `The site answers and Statiku's code is on its home page, so check that the pages people visit still load it.`],
        }[kind];
        await tellOwners(site, kind === "down" ? `${domain} looks down` : kind === "missing" ? `Statiku's code is missing from ${domain}` : `${domain} has gone quiet`, {
          heading: kind === "down" ? `${domain} looks down` : kind === "missing" ? `Statiku's code is missing from ${domain}` : `No visits on ${domain} for an hour`,
          lines, button: { label: kind === "missing" ? "Set it up again" : "Open the live view", url: kind === "missing" ? `${o.origin()}/sites/${site.key}/setup` : live },
          foot: "You'll get one more email when visits come back. Turn these off in the site's settings.",
        });
        continue;
      }
      // A rush: at least 30 page views in 15 minutes, and six times the usual.
      const recent = !site.surge_at || now.getTime() - new Date(site.surge_at).getTime() > 6 * 3600_000;
      if (site.surge && recent && site.last_quarter >= Math.max(30, 6 * (site.usual_hour / 4))) {
        const { rows: [top] } = await pool.query(
          `select source, count(*)::int as n from events where project_id = $1 and name = 'pageview' and ts > $2::timestamptz - interval '15 minutes' and ts <= $2
            group by 1 order by 2 desc limit 1`,
          [site.id, now],
        );
        await pool.query("update projects set surge_at = $2 where id = $1", [site.id, now]);
        const share = Math.round((100 * top.n) / site.last_quarter);
        const from = top.source !== "Direct" && share >= 40 ? `, ${share}% of them from ${top.source}` : "";
        await tellOwners(site, `${domain} is getting a rush${top.source !== "Direct" && share >= 40 ? ` from ${top.source}` : ""}`, {
          heading: `A rush on ${domain}`,
          lines: [`${site.last_quarter} page views in the last 15 minutes${from}, about ${Math.max(6, Math.round(site.last_quarter / Math.max(site.usual_hour / 4, 1)))} times the usual.`, "Someone may have just linked to you. It's a good moment to answer comments and questions."],
          button: { label: "Watch it live", url: live },
          foot: "At most one of these every six hours. Turn them off in the site's settings.",
        });
      }
    }
  }
  return { watch };
}
