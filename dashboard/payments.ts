// What a site's customers pay through Stripe or Polar, credited to the visit that led to the payment. The website
// script adds a reference to each checkout link it sees clicked (Stripe's client_reference_id, Polar's reference_id)
// and counts the click as "checkout"; the provider's webhook, signed with the site's own secret, brings the reference
// back with the payment, which becomes a "purchase" event with the checkout visit's source, campaign and page. A
// payment without a known reference still counts, as "Not matched".
//   Stripe: POST /api/pay/stripe/:key, for checkout.session.completed (and async_payment_succeeded)
//   Polar:  POST /api/pay/polar/:key,  for order.paid
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Hub } from "../ingest/live.ts";
import { verifyWebhook } from "./billing.ts";
import { unseal } from "./secrets.ts";

export type Provider = "stripe" | "polar";
export type Payment = { id: string; ref: string | null; minor: number; currency: string };

// Stripe-Signature: t=…,v1=… — an HMAC of "t.body" with the endpoint's secret, within five minutes.
export function verifyStripe(secret: string, header: string | undefined, body: Buffer, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(body).digest();
  return parts.filter(([k]) => k === "v1").some(([, v]) => {
    const given = Buffer.from(v ?? "", "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function verifyPayment(provider: Provider, secret: string, header: (name: string) => string | undefined, body: Buffer, now = Date.now()) {
  return provider === "stripe"
    ? verifyStripe(secret, header("stripe-signature"), body, now)
    : verifyWebhook(secret, { id: header("webhook-id"), timestamp: header("webhook-timestamp"), signature: header("webhook-signature") }, body, now);
}

const refOf = (v: unknown) => (typeof v === "string" && /^[\w-]{4,80}$/.test(v) ? v : null);

// The payment in a webhook's event, if it's one: what was paid, in the currency's smallest unit, and its reference.
export function paymentOf(provider: Provider, event: { type?: string; data?: any }): Payment | null {
  const o = provider === "stripe" ? event.data?.object : event.data;
  if (!o || typeof o !== "object") return null;
  if (provider === "stripe") {
    const paid = (event.type === "checkout.session.completed" && o.payment_status === "paid") || event.type === "checkout.session.async_payment_succeeded";
    if (!paid || typeof o.amount_total !== "number" || typeof o.currency !== "string") return null;
    return { id: String(o.id), ref: refOf(o.client_reference_id), minor: o.amount_total, currency: o.currency.toUpperCase() };
  }
  if (event.type !== "order.paid") return null;
  const minor = [o.total_amount, o.net_amount, o.amount].find((a) => typeof a === "number");
  if (minor === undefined || typeof o.currency !== "string") return null;
  const ref = [o.metadata?.reference_id, o.metadata?.statiku_ref, o.checkout?.metadata?.reference_id, o.custom_field_data?.reference_id, o.reference_id].map(refOf).find(Boolean) ?? null;
  return { id: String(o.id), ref, minor, currency: o.currency.toUpperCase() };
}

export async function payingSite(pool: pg.Pool, key: string, provider: Provider) {
  const { rows: [site] } = await pool.query(`select id, ${provider === "stripe" ? "stripe_secret" : "polar_secret"} as secret from projects where key = $1`, [key]);
  if (!site?.secret) return null;
  const secret = unseal(site.secret);
  return secret ? { id: site.id as string, secret } : null;
}

// A payment, once: a "purchase" with the checkout's visit details, counted towards the site's events and shown live.
export async function recordPayment(pool: pg.Pool, hub: Hub, projectId: string, provider: Provider, payment: Payment, now = new Date()) {
  const { rowCount } = await pool.query("insert into payments (project_id, provider, id) values ($1, $2, $3) on conflict do nothing", [projectId, provider, payment.id]);
  if (!rowCount) return { recorded: false, matched: false };
  const { rows: [checkout] } = payment.ref
    ? await pool.query(
      `select session_id, visitor, hostname, path, source, referrer_host, utm_medium, utm_campaign, utm_content, utm_term, country, device, browser, os
         from events where name = 'checkout' and props ->> 'ref' = $2 and project_id = $1 order by ts desc limit 1`,
      [projectId, payment.ref],
    )
    : { rows: [] };
  const c = checkout ?? {};
  await pool.query(
    `insert into events (project_id, ts, name, session_id, visitor, hostname, path, source, referrer_host, utm_medium, utm_campaign, utm_content, utm_term,
                         country, device, browser, os, props, revenue_minor, currency)
     values ($1, $2, 'purchase', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [projectId, now, c.session_id ?? null, c.visitor ?? null, c.hostname ?? null, c.path ?? null, c.source ?? null, c.referrer_host ?? null, c.utm_medium ?? null,
      c.utm_campaign ?? null, c.utm_content ?? null, c.utm_term ?? null, c.country ?? null, c.device ?? null, c.browser ?? null, c.os ?? null,
      JSON.stringify({ via: provider, ...(payment.ref ? { ref: payment.ref } : {}) }), payment.minor, payment.currency],
  );
  await pool.query(
    `insert into usage_daily (project_id, day, events) values ($1, ($2::timestamptz at time zone 'utc')::date, 1)
     on conflict (project_id, day) do update set events = usage_daily.events + 1`,
    [projectId, now],
  );
  hub.publish(projectId, {
    t: "event",
    e: { ts: now, name: "purchase", path: c.path ?? null, country: c.country ?? null, source: c.source ?? null, device: c.device ?? null, browser: c.browser ?? null, os: c.os ?? null,
      app: false, city: null, revenue: { minor: payment.minor, currency: payment.currency }, first: false },
  });
  return { recorded: true, matched: !!checkout };
}
