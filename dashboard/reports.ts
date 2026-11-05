// The weekly match report: each Monday from 08:00 in the site's time zone, last week against the week before, read
// like a result. Visitors, visits, goals and revenue are each won, lost or drawn ("you beat last week 3–1"), with
// the star player (the best rated page), the top scorer (the source with the most goals), the assist of the week, the
// injuries and the site's numbers. By email to the site's owners, and to Slack if the site has an incoming webhook.
import type pg from "pg";
import { letter, type Mailer } from "./mail.ts";
import { goalsOf } from "./match.ts";
import { assists, injuries, ratings, revenue } from "./insights.ts";
import type { Outbound } from "./check.ts";

export type Report = { heading: string; lines: string[]; url: string; score: [number, number] };
type ReportSite = { id: string; key: string; name: string; domains: string[]; timezone: string; goals?: string[] | null };

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (minor: number, currency: string) => {
  try {
    const f = new Intl.NumberFormat("en", { style: "currency", currency });
    return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${minor} ${currency}`;
  }
};
const change = (now: number, before: number) =>
  !before ? (now ? "new this week" : "none either week") : now === before ? "the same as the week before"
    : `${now > before ? "up" : "down"} ${Math.abs(Math.round(((now - before) / before) * 100))}% on the week before`;

// Last week (Monday to Monday in the site's time zone, as of `now`) against the week before it.
export async function weekReport(pool: pg.Pool, site: ReportSite, origin: string, now = new Date()): Promise<Report> {
  const { rows: [w] } = await pool.query(
    `select (date_trunc('week', $1::timestamptz at time zone $2) - interval '7 days') at time zone $2 as "from",
            date_trunc('week', $1::timestamptz at time zone $2) at time zone $2 as "to",
            (date_trunc('week', $1::timestamptz at time zone $2) - interval '14 days') at time zone $2 as "prevFrom",
            (date_trunc('week', $1::timestamptz at time zone $2) - interval '7 days')::date::text as "firstDay",
            (date_trunc('week', $1::timestamptz at time zone $2) - interval '1 day')::date::text as "lastDay"`,
    [now, site.timezone],
  );
  const goals = goalsOf(site);
  const week = async (from: Date, to: Date) => {
    const { rows: [t] } = await pool.query(
      `select (select count(distinct (visitor, (ts at time zone 'utc')::date)) from events where project_id = $1 and ts >= $2 and ts < $3)::int as visitors,
              (select count(*) from sessions where project_id = $1 and started_at >= $2 and started_at < $3)::int as visits,
              (select count(*) from events where project_id = $1 and ts >= $2 and ts < $3 and (name = any($4) or revenue_minor is not null))::int as goals`,
      [site.id, from, to, goals],
    );
    return t as { visitors: number; visits: number; goals: number };
  };
  const [now7, before7, helped, hurt, earned, numbers] = await Promise.all([
    week(w.from, w.to), week(w.prevFrom, w.from),
    assists(pool, site, w.from, w.to, goals), injuries(pool, site, w.from, w.to), revenue(pool, site, w.from, w.to, w.prevFrom, w.from),
    pool.query(
      `select m.name, m.kind, case when m.kind = 'add' then sum(p.value)::text when m.kind = 'set' then ((array_agg(p.value order by p.ts desc))[1])::text
              else (array_agg(p.text_value order by p.ts desc))[1] end as value
         from metrics m join metric_points p on p.project_id = m.project_id and p.name = m.name and p.ts >= $2 and p.ts < $3
        where m.project_id = $1 group by 1, 2 order by max(p.ts) desc limit 4`,
      [site.id, w.from, w.to],
    ).then((r) => r.rows),
  ]);
  const rated = await ratings(pool, site, w.from, w.to, new Map(helped.pages.map((p) => [p.label, p.v])), helped.goals);

  // Each measure is a game won, lost or drawn; revenue plays only if there was any.
  const cur = earned.totals[0]?.currency ?? earned.previous[0]?.currency ?? null;
  const takings = (rows: { currency: string; minor: number }[]) => rows.find((r) => r.currency === cur)?.minor ?? 0;
  const games: [string, number, number, (n: number) => string][] = [
    ["Visitors", now7.visitors, before7.visitors, int],
    ["Visits", now7.visits, before7.visits, int],
    ["Goals", now7.goals, before7.goals, int],
    ...(cur ? [["Revenue", takings(earned.totals), takings(earned.previous), (n: number) => money(n, cur)] as [string, number, number, (n: number) => string]] : []),
  ];
  const won = games.filter(([, a, b]) => a > b).length, lost = games.filter(([, a, b]) => a < b).length;
  const domain = site.domains[0];
  const heading = won > lost ? `${domain}: you beat last week ${won}–${lost}` : won < lost ? `${domain}: the week before won ${lost}–${won}` : `${domain}: a ${won}–${lost} draw with the week before`;

  const best = rated.pages.find((p) => p.path === rated.best);
  const scorer = helped.sources[0];
  const assist = helped.pages[0];
  const sore = [
    hurt.errors.length ? `${int(hurt.errors.reduce((a: number, e: any) => a + e.n, 0))} script errors, most often "${String(hurt.errors[0].message).slice(0, 80)}"` : null,
    (hurt.slow[0]?.lcp ?? 0) > 4000 ? `${hurt.slow[0].path} is slow to load (${((hurt.slow[0].lcp ?? 0) / 1000).toFixed(1)}s for one visit in four)` : null,
    hurt.broken.length ? `${hurt.broken.length} ${hurt.broken.length === 1 ? "page" : "pages"} answered with an error, such as ${hurt.broken[0].path} (${hurt.broken[0].status})` : null,
  ].filter(Boolean);
  const lines = [
    ...games.map(([name, a, b, fmt]) => `${name}: ${fmt(a)}, ${change(a, b)}.`),
    best ? `Star player: ${best.path}, rated ${best.rating.toFixed(1)} out of 10.` : null,
    scorer?.scored ? `Top scorer: ${scorer.label}, with ${int(scorer.scored)} ${scorer.scored === 1 ? "goal" : "goals"}.` : null,
    assist?.v ? `Assist of the week: ${assist.label}, seen before ${int(assist.v)} of the goals.` : null,
    sore.length ? `Injuries: ${sore.join("; ")}.` : "Injuries: none.",
    numbers.length ? `Trackers: ${numbers.map((n) => `${n.name} ${n.kind === "text" ? n.value : Number(n.value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`).join(", ")}.` : null,
  ].filter((l): l is string => !!l);
  return { heading, lines, url: `${origin}/sites/${site.key}?range=custom&from=${w.firstDay}&to=${w.lastDay}`, score: [won, lost] };
}

// Slack's incoming webhooks only.
export const slackHook = (input: unknown) => {
  const url = typeof input === "string" ? input.trim() : "";
  return /^https:\/\/hooks\.slack\.com\/services\/[\w/-]{10,200}$/.test(url) ? url : null;
};

export function createReports(o: { pool: pg.Pool; mailer: Mailer; origin: () => string; post?: Outbound }) {
  const { pool, mailer } = o;
  const post: Outbound = o.post ?? (async (url, init) => {
    const res = await fetch(url, { method: init?.method ?? "POST", headers: init?.headers, body: init?.body, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: Buffer.from(await res.arrayBuffer()) };
  });

  async function deliver(site: ReportSite & { report_weekly?: boolean; slack_webhook?: string | null }, report: Report, to: string[] | null) {
    const recipients = to ?? (site.report_weekly ? (await pool.query(
      `select u.email from projects p join memberships m on m.workspace_id = p.workspace_id and m.role = 'owner' join users u on u.id = m.user_id where p.id = $1`,
      [site.id],
    )).rows.map((r) => r.email) : []);
    for (const email of recipients) {
      await mailer({ to: email, subject: report.heading, ...letter({ heading: report.heading, lines: report.lines, button: { label: "Open last week's report", url: report.url }, foot: "The weekly match report. Turn it off in the site's settings." }) })
        .catch((e) => console.error("Report email:", (e as Error).message));
    }
    if (site.slack_webhook) {
      const text = `:soccer: *${report.heading}*\n${report.lines.map((l) => `• ${l}`).join("\n")}\n<${report.url}|Open last week's report>`;
      await post(new URL(site.slack_webhook), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
        .catch((e) => console.error("Report to Slack:", (e as Error).message));
    }
  }

  // Each site due a report this hour: Monday, 08:00 or later where it is, and none sent yet this week.
  async function send(now = new Date()) {
    const { rows } = await pool.query(
      `select p.id, p.key, p.name, p.domains, p.timezone, p.goals, p.report_weekly, p.slack_webhook,
              date_trunc('week', $1::timestamptz at time zone p.timezone)::date as this_week
         from projects p
        where (p.report_weekly or p.slack_webhook is not null)
          and extract(isodow from $1::timestamptz at time zone p.timezone) = 1 and extract(hour from $1::timestamptz at time zone p.timezone) >= 8
          and (p.report_week is null or p.report_week < date_trunc('week', $1::timestamptz at time zone p.timezone)::date)
          and exists (select 1 from events e where e.project_id = p.id and e.ts > $1::timestamptz - interval '14 days')`,
      [now],
    );
    let sent = 0;
    for (const site of rows) {
      // Claimed first, so two runs never send the same week twice.
      const { rowCount } = await pool.query("update projects set report_week = $2 where id = $1 and (report_week is null or report_week < $2)", [site.id, site.this_week]);
      if (!rowCount) continue;
      try {
        await deliver(site, await weekReport(pool, site, o.origin(), now), null);
        sent++;
      } catch (e) {
        console.error("Weekly report:", (e as Error).message);
      }
    }
    return sent;
  }

  // A report now, for the settings page's "send me one": to the person asking (and Slack, if the site has it).
  async function sendNow(site: ReportSite & { slack_webhook?: string | null }, to: string, now = new Date()) {
    const report = await weekReport(pool, site, o.origin(), now);
    await deliver(site, report, [to]);
    return report;
  }

  return { send, sendNow };
}
