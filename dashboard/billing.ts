// Statiku's own plans, paid through Polar, which sells as the merchant of record and so also handles VAT. Every
// workspace starts with a 30-day trial; then a plan by how many events its sites send in a month. When the trial ends
// unpaid, the reports close until a plan is chosen, but counting goes on, so nothing is lost meanwhile. Going over a
// plan's events only brings a reminder.
//
// In Polar, make one product per plan and billing period, then set (on Render):
//   POLAR_ACCESS_TOKEN    an organization access token with checkouts:write and customer_sessions:write
//   POLAR_WEBHOOK_SECRET  the secret of a webhook to https://<this service>/api/polar/webhook, for subscription events
//   POLAR_PRODUCTS        starter:month=<product id>,starter:year=<product id>,growth:month=…  (as many as there are)
//   POLAR_API             https://sandbox-api.polar.sh while trying it out (production is the default)
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Outbound } from "./check.ts";

export const TRIAL_DAYS = 30;
// Prices in euros. A year costs ten months.
export const PLANS = [
  { id: "starter", name: "Starter", events: 10_000, month: 9, year: 90 },
  { id: "growth", name: "Growth", events: 100_000, month: 19, year: 190 },
  { id: "business", name: "Business", events: 1_000_000, month: 69, year: 690 },
  { id: "scale", name: "Scale", events: 10_000_000, month: 199, year: 1990 },
];

export type Polar = { api: string; token?: string; secret?: string; products: Record<string, string> };

export function polarFromEnv(env = process.env): Polar {
  const products: Record<string, string> = {};
  for (const pair of (env.POLAR_PRODUCTS ?? "").split(",")) {
    const [name, id] = pair.split("=").map((s) => s.trim());
    if (/^[a-z]+:(month|year)$/.test(name ?? "") && id) products[name] = id;
  }
  return { api: env.POLAR_API ?? "https://api.polar.sh", token: env.POLAR_ACCESS_TOKEN, secret: env.POLAR_WEBHOOK_SECRET, products };
}

export type Billing = { plan: string; status: string | null; trialEndsAt: Date | null; periodEnd: Date | null; cancelAtPeriodEnd: boolean };
export const BILLING_COLUMNS = `w.plan, w.subscription_status as status, w.trial_ends_at as "trialEndsAt", w.period_end as "periodEnd",
  w.cancel_at_period_end as "cancelAtPeriodEnd"`;

// Whether a workspace's reports are open, and why: a plan given for free ("comp"), a subscription that's paid (or
// whose payment is being retried), time already paid for after cancelling, or the trial.
export function access(b: Billing, now = new Date()): "comp" | "paid" | "trial" | "locked" {
  if (b.plan === "comp") return "comp";
  if (b.status && ["active", "trialing", "past_due"].includes(b.status)) return "paid";
  if (b.plan !== "free" && b.periodEnd && new Date(b.periodEnd) > now) return "paid";
  if (b.trialEndsAt && new Date(b.trialEndsAt) > now) return "trial";
  return "locked";
}

export const planOf = (id: string) => PLANS.find((p) => p.id === id) ?? null;

// Events a workspace's sites sent this calendar month (UTC).
export async function usage(pool: pg.Pool, workspaceId: string): Promise<number> {
  const { rows: [row] } = await pool.query(
    `select coalesce(sum(u.events), 0)::bigint as n from usage_daily u join projects p on p.id = u.project_id
      where p.workspace_id = $1 and u.day >= date_trunc('month', now() at time zone 'utc')::date`,
    [workspaceId],
  );
  return Number(row.n);
}

const parse = (body: Buffer) => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
};

async function polarCall(request: Outbound, polar: Polar, path: string, body: object) {
  const res = await request(new URL(path, polar.api), {
    method: "POST",
    headers: { authorization: `Bearer ${polar.token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: parse(res.body) };
}

// A Polar checkout for one plan; the workspace is the customer, by Statiku's own ID for it.
export async function checkoutUrl(request: Outbound, polar: Polar, o: { product: string; workspaceId: string; email: string; success: string }) {
  const { status, data } = await polarCall(request, polar, "/v1/checkouts/", {
    products: [o.product], success_url: o.success, customer_email: o.email, external_customer_id: o.workspaceId, metadata: { workspace: o.workspaceId },
  });
  if (status >= 400 || !data?.url) throw new Error(`Polar couldn't start a checkout (${data?.detail?.[0]?.msg ?? data?.detail ?? status}).`);
  return String(data.url);
}

// Polar's page where a customer changes their plan, card or invoices.
export async function portalUrl(request: Outbound, polar: Polar, workspaceId: string, back: string) {
  const { status, data } = await polarCall(request, polar, "/v1/customer-sessions/", { external_customer_id: workspaceId, return_url: back });
  if (status >= 400 || !data?.customer_portal_url) return null;
  return String(data.customer_portal_url);
}

// Polar signs each delivery the Standard Webhooks way: a base64 HMAC-SHA256 of "id.timestamp.body". Secrets made since
// September 2026 are "whsec_" and the key in base64; older ones are keyed by the whole string's bytes. Both are tried,
// as Polar's own SDK does. A delivery more than five minutes old or early is refused, so it can't be replayed later.
export function verifyWebhook(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: Buffer, now = Date.now()) {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const at = Number(timestamp);
  if (!Number.isFinite(at) || Math.abs(now / 1000 - at) > 300) return false;
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body]);
  const keys = [Buffer.from(secret, "utf8"), ...(secret.startsWith("whsec_") ? [Buffer.from(secret.slice(6), "base64")] : [])];
  const given = signature.split(" ").map((s) => s.split(",")).filter(([v]) => v === "v1").map(([, sig]) => Buffer.from(sig ?? "", "base64"));
  return keys.some((key) => {
    const expected = createHmac("sha256", key).update(signed).digest();
    return given.some((g) => g.length === expected.length && timingSafeEqual(g, expected));
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A subscription event: the workspace takes the plan of the product, its status and how long it's paid for. An
// older delivery arriving after a newer one changes nothing.
export async function applySubscription(pool: pg.Pool, polar: Polar, event: { type?: string; data?: Record<string, any> }, sentAt: Date) {
  if (!event.type?.startsWith("subscription.") || !event.data) return false;
  const s = event.data;
  const workspace = s.customer?.external_id ?? s.metadata?.workspace;
  if (typeof workspace !== "string" || !UUID.test(workspace)) return false;
  const plan = Object.entries(polar.products).find(([, product]) => product === s.product_id)?.[0].split(":")[0];
  if (!plan) return false;
  const { rowCount } = await pool.query(
    `update workspaces set plan = $2, subscription_id = $3, subscription_status = $4, period_end = $5, cancel_at_period_end = $6,
            polar_customer_id = $7, billing_updated_at = $8
      where id = $1 and plan <> 'comp' and (billing_updated_at is null or billing_updated_at <= $8)`,
    [workspace, plan, String(s.id ?? ""), String(s.status ?? ""), s.ends_at ?? s.current_period_end ?? null, !!s.cancel_at_period_end, s.customer?.id ?? null, sentAt],
  );
  return rowCount === 1;
}
