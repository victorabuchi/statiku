// Asking a site's numbers questions in plain words. "What changed?" always has an answer, worked out here: the
// period against the one before, the sources, pages, countries and devices that moved it most, goals and revenue,
// and the busiest and quietest days. A question of any other kind ("why did traffic drop on Tuesday?") goes to
// Claude with a compact summary of the site's numbers, when the server has ANTHROPIC_API_KEY; without it, the answer
// is "what changed".
import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import type { Site } from "./stats.ts";

export type Bounds = { from: Date; to: Date; prevFrom: Date; prevTo: Date; id: string };
export type Asker = (question: string, pack: unknown, site: { name: string; domain: string }) => Promise<string>;

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${int(Math.abs(n))}`;
const money = (minor: number, currency: string) => {
  try {
    const f = new Intl.NumberFormat("en", { style: "currency", currency });
    return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${minor} ${currency}`;
  }
};
const regions = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code: string) => {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};
const q = async (pool: pg.Pool, sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;

// The numbers both answers are made from: totals for the period and the one before, visits by source, landing page,
// country and device in each, and the period day by day (or week by week past three months) with its top sources.
export async function numbersFor(pool: pg.Pool, site: Site, b: Bounds, goals: string[]) {
  const p = [site.id, b.from, b.to, b.prevFrom, b.prevTo];
  const BOTH = "project_id = $1 and ((started_at >= $2 and started_at < $3) or (started_at >= $4 and started_at < $5))";
  const days = (b.to.getTime() - b.from.getTime()) / 86400e3;
  const unit = days > 92 ? "week" : "day";
  const [totals, movers, daily, events] = await Promise.all([
    q(pool, `select n.period,
                    (select count(distinct (visitor, (ts at time zone 'utc')::date)) from events where project_id = $1 and ts >= n.f and ts < n.t)::int as visitors,
                    (select count(*) from sessions where project_id = $1 and started_at >= n.f and started_at < n.t)::int as visits,
                    (select count(*) from events where project_id = $1 and ts >= n.f and ts < n.t and name = 'pageview')::int as pageviews,
                    (select count(*) from events where project_id = $1 and ts >= n.f and ts < n.t and (name = any($6) or revenue_minor is not null))::int as goals,
                    (select json_agg(r) from (select currency, sum(revenue_minor)::bigint as minor from events
                       where project_id = $1 and ts >= n.f and ts < n.t and revenue_minor is not null group by 1 order by 2 desc) r) as revenue
               from (values ('now', $2::timestamptz, $3::timestamptz), ('before', $4::timestamptz, $5::timestamptz)) n(period, f, t)`, [...p, goals]),
    q(pool, `select dim, label, (count(*) filter (where started_at >= $2))::int as now, (count(*) filter (where started_at < $2))::int as before
               from sessions cross join lateral (values ('source', source), ('page', entry_path), ('country', country), ('device', device)) d(dim, label)
              where ${BOTH} and label is not null group by 1, 2`, p),
    q(pool, `with d as (select date_trunc($4, started_at at time zone $5) as t, source, visitor from sessions where project_id = $1 and started_at >= $2 and started_at < $3)
             select to_char(t, 'YYYY-MM-DD') as day, to_char(t, 'Dy') as weekday, count(*)::int as visits, count(distinct visitor)::int as visitors,
                    (select json_object_agg(source, n) from (select source, count(*) as n from d d2 where d2.t = d.t group by 1 order by 2 desc limit 5) x) as sources
               from d group by t order by t`, [site.id, b.from, b.to, unit, site.timezone]),
    q(pool, `select name, (count(*) filter (where ts >= $2))::int as now, (count(*) filter (where ts < $2))::int as before from events
              where project_id = $1 and ((ts >= $2 and ts < $3) or (ts >= $4 and ts < $5)) and name <> 'pageview' group by 1 order by 2 desc limit 12`, p),
  ]);
  const now = totals.find((t) => t.period === "now"), before = totals.find((t) => t.period === "before");
  const byDim: Record<string, { label: string; now: number; before: number; change: number }[]> = {};
  for (const m of movers) (byDim[m.dim] ??= []).push({ label: m.label, now: m.now, before: m.before, change: m.now - m.before });
  for (const dim of Object.keys(byDim)) byDim[dim].sort((a, z) => Math.abs(z.change) - Math.abs(a.change) || z.now - a.now);
  return {
    period: { from: b.from, to: b.to, previousFrom: b.prevFrom, previousTo: b.prevTo, timezone: site.timezone, comparable: b.id !== "all" },
    now, before, movers: byDim, [unit === "week" ? "weekly" : "daily"]: daily, events,
  } as const;
}

// "What changed": a few plain sentences from those numbers.
export function whatChanged(n: Awaited<ReturnType<typeof numbersFor>>) {
  const lines: string[] = [];
  const { now, before } = n;
  const d = now.visitors - before.visitors;
  if (!n.period.comparable) lines.push(`${int(now.visitors)} visitors and ${int(now.visits)} visits in all.`);
  else if (!before.visitors) lines.push(now.visitors ? `${int(now.visitors)} visitors, where the period before had none.` : "No visitors in this period or the one before.");
  else if (Math.abs(d) / before.visitors < 0.03) lines.push(`Visitors held steady: ${int(now.visitors)}, against ${int(before.visitors)} in the period before.`);
  else lines.push(`Visitors ${d > 0 ? "rose" : "fell"} ${Math.abs(Math.round((100 * d) / before.visitors))}%, from ${int(before.visitors)} to ${int(now.visitors)}.`);

  if (n.period.comparable && now.visits !== before.visits) {
    const sources = n.movers.source ?? [];
    const visitsChange = now.visits - before.visits;
    const same = sources.filter((s) => Math.sign(s.change) === Math.sign(visitsChange) && s.change !== 0).slice(0, 2);
    const other = sources.find((s) => Math.sign(s.change) === -Math.sign(visitsChange) && Math.abs(s.change) >= 3);
    if (same.length) lines.push(`Most of the ${visitsChange > 0 ? "gain" : "drop"} came from ${same.map((s) => `${s.label} (${signed(s.change)} visits)`).join(" and ")}.`);
    if (other) lines.push(`Against the trend, ${other.label} ${other.change > 0 ? "grew" : "fell"} (${signed(other.change)}).`);
    const notable = (["page", "country", "device"] as const)
      .map((dim) => [dim, (n.movers[dim] ?? [])[0]] as const)
      .filter(([, m]) => m && Math.abs(m.change) >= Math.max(3, Math.abs(visitsChange) * 0.15));
    const say = { page: (l: string) => `${l === "/" ? "the home page" : l} as a landing page`, country: (l: string) => `visitors from ${countryName(l)}`, device: (l: string) => `${l.toLowerCase()} visits` };
    if (notable.length) lines.push(`Biggest moves elsewhere: ${notable.map(([dim, m]) => `${say[dim](m!.label)} (${signed(m!.change)})`).join(", ")}.`);
  }
  if (now.goals || before.goals) lines.push(`Goals: ${int(now.goals)}${n.period.comparable ? `, against ${int(before.goals)} before` : ""}.`);
  const cur = now.revenue?.[0]?.currency ?? before.revenue?.[0]?.currency;
  if (cur) {
    const take = (r: { currency: string; minor: number }[] | null) => Number(r?.find((x) => x.currency === cur)?.minor ?? 0);
    lines.push(`Revenue: ${money(take(now.revenue), cur)}${n.period.comparable ? `, against ${money(take(before.revenue), cur)} before` : ""}.`);
  }
  const days = ("daily" in n ? n.daily : n.weekly) as { day: string; weekday: string; visits: number }[];
  if (days.length > 2) {
    const busiest = days.reduce((a, z) => (z.visits > a.visits ? z : a)), quietest = days.reduce((a, z) => (z.visits < a.visits ? z : a));
    const when = (x: { day: string; weekday: string }) => `${"daily" in n ? `${x.weekday} ` : "the week of "}${new Date(`${x.day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
    lines.push(`Busiest ${"daily" in n ? "day" : "week"}: ${when(busiest)}, with ${int(busiest.visits)} visits; quietest: ${when(quietest)}, with ${int(quietest.visits)}.`);
  }
  return lines;
}

const SYSTEM = `You answer a website owner's questions about their site's analytics in Statiku. The user message holds the site's
numbers as JSON: totals for the period and the previous period of the same length, visits by source, landing page,
country and device in both (with the change), the period day by day (or week by week) with its top sources, and its
events. Answer from these numbers only, with the figures that support the answer. If they can't answer the question,
say what's missing. Write plain sentences, at most about 120 words, without headings or tables.`;

// Claude, when the server has a key; otherwise none, and "what changed" answers instead.
export function askerFromEnv(): Asker | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async (question, pack, site) => {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // If the model declines, the API answers with the next model it routes to instead.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Site: ${site.name} (${site.domain})\n\nNumbers:\n${JSON.stringify(pack)}\n\nQuestion: ${question}` }],
    });
    if (response.stop_reason === "refusal") return "That's a question I can't answer from here.";
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    return text || "There's no answer to that in these numbers.";
  };
}
