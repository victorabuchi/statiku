# Statiku: stack, data model and plan

Statiku is privacy-first analytics for websites and apps (Mac, iOS, desktop) that follows each
traffic source from the first visit to the purchase:

```
visit → download click → app installed → trial → purchase
  web      web             app SDK         app SDK  Polar / Stripe webhook
```

Notchlight (notchlight.com) is the first customer.

## Promises

- No cookies, no localStorage and no fingerprint that lives longer than a day. No consent banner is needed.
- IP addresses are never stored or logged. The IP is used in memory to look up the country and to build a daily hash,
  then dropped.
- Data stays in the EU: the service and the database run in Render's Frankfurt region.
- The website script stays under 2 KB.

## Stack

| Part | Choice | Why |
| --- | --- | --- |
| Language | TypeScript on Node 24, run directly (Node strips the types), no build step for servers | One language for the services, the script and the dashboard; the stack you already use |
| Ingest | `ingest/`: a small `node:http` service, no framework | It is the hot path; it stays tiny and scales on its own |
| Database | Postgres 17 on Render (Frankfurt), `pg` driver, plain SQL migrations | Simple to start; events are partitioned by month so it grows |
| Country lookup | DB-IP Country Lite (`.mmdb`, CC BY 4.0), downloaded at build time, read with `mmdb-lib` | Country only, offline, no third-party calls |
| Website script | `tracker/`: plain JS, minified with esbuild, served at `/s.js` | Under 2 KB |
| App SDK (next) | Swift package for macOS and iOS | Notchlight first |
| Dashboard | `dashboard/`: one page and a JSON API on `node:http`, Pursecast-style UI; local only until sign-in exists | Small, no build step, same stack as ingest |
| SaaS billing (later) | Polar as merchant of record | It handles EU VAT, and you already use it |
| Hosting | Render Blueprint (`render.yaml`): ingest web service + Postgres, both in Frankfurt | Your current host |

### Growth path

1. **Now:** one ingest instance buffers events in memory and writes them in batches (one transaction per second or per
   500 events). `events` and `sessions` are partitioned by month, so old months can be dropped or archived cheaply and
   recent queries stay fast. This is comfortable into tens of millions of events a month.
2. **Then:** hourly rollup tables per project so the dashboard never scans raw events; more ingest instances, with the
   live-session cache moved to Render Key Value (Redis).
3. **At scale:** raw events move to ClickHouse in an EU region. Only `ingest/writer.ts` and the dashboard's queries
   change; accounts, projects, installs and revenue stay in Postgres.

## How the privacy works

- **Visitors:** `visitor = HMAC(salt_of_the_day, project + IP + user agent)`, kept as a 63-bit number. Each UTC day gets
  a new random salt, and salts are deleted after two days, so a hash can't be traced back to an IP or linked across
  days. A visitor who returns on another day counts again.
- **Sessions:** a session is a visitor's events with gaps under 30 minutes. Its source (UTM, then the referrer, then
  Direct) is set by its first event and copied onto every event in it, so "downloads by source" is a simple count.
- **What the script sends:** the event name, the page URL without its query string (only `utm_*`, `ref`, `source` and
  `via` are kept), the referrer, the window width (for the device type) and optional props.
- **Country:** looked up from the IP in memory. No city, no region.
- **Bots:** dropped by user agent; automated browsers are skipped by the script.
- **Opting out:** site owners set `localStorage.statiku_ignore = "1"` in their own browser; the app SDK has an opt-out
  switch.

## Attribution: how each step finds its source

| Step | How it is linked | Kind |
| --- | --- | --- |
| Visit | UTM tags, then the referrer | exact |
| Download click | Same session as the visit (the script tracks clicks on `.dmg`, `.zip`, `.pkg`, `.exe` and links with `data-track`) | exact |
| Install | When the app first pings, it is matched to a download click from the same network within 24 hours. The match uses `HMAC(salt_of_the_day, project + IP)`, kept in a table that is emptied after 48 hours | estimate, shown as such |
| Trial, licensed | Reported by the SDK on the install | exact |
| Purchase on the website | The script adds `reference_id=stk_…` (Polar) or `client_reference_id=stk_…` (Stripe Payment Links) to checkout links when clicked, and records a `checkout` event with that ref. The webhook carries it back | exact |
| Purchase in the app | The SDK adds the install ID as the reference on the checkout link | exact, then through the install's source |

## Data model

Accounts (built with the dashboard):

- `users` (id, email, name, password_hash, email_verified_at)
- `workspaces` (id, name, plan, billing ids): the billing unit
- `memberships` (workspace, user, role: owner, admin or member)
- `invites` (workspace, email, role, token hash, expires_at, accepted_at)

Collection (built now):

- `projects` (id, workspace, public `key`, name, `domains[]` the script may report from, timezone): a website, an
  app, or both
- `salts` (day, salt): today's and yesterday's only
- `sessions` partitioned by month on `started_at`: visitor hash, started and last seen, entry and exit page, page views,
  events, source fields, country, device, browser, OS
- `events` partitioned by month on `ts`: name (`pageview` or a custom name), session, visitor, hostname, path, the
  session's source fields, country, device, browser, OS, props (jsonb), revenue (smallest unit + currency)
- `usage_daily` (project, day, events): for plan limits and billing

Apps (next):

- `installs` (project, random install ID, first and last seen, platform, app version, OS version, state: trial, licensed
  or free, country, attributed source and how it was matched)
- `download_marks` (project, network hash, time, session, source): emptied after 48 hours
- app events go into `events` with `install_id`, `app_version` and `os_version` set

Revenue (after that):

- `webhook_endpoints` (project, provider, signing secret)
- `purchases` (project, provider, provider order ID, time, amount, currency, reference, install, attributed source,
  status: paid or refunded)

## Plan

1. **Ingestion and the website script** (this step): `/e`, `/s.js`, sessions, country, devices, sources, custom events,
   checkout and download tracking, a CLI for projects and a stats report until the dashboard exists. Tested on
   notchlight.com's pages in Chrome, then live on notchlight.com.
2. **Swift SDK and app ingestion:** `/v1/app`, installs, active installs by version, trial and licensed state, opt-out,
   install attribution. Into Notchlight with the privacy page updated the same day.
3. **Revenue:** Polar and Stripe webhooks, attributed back to the source. Paddle, Lemon Squeezy and the App Store later.
4. **Accounts and dashboard:** sign-up, workspaces, projects, invites, and per project: visitors, pages, sources,
   countries, devices, the funnel, installs, revenue by source.
5. **Billing:** a free tier, then paid plans by monthly events, through Polar.
6. **Launch:** a name and domain, the landing page, docs, privacy policy and DPA.
