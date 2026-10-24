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
- The website script stays under 10 KB.

## Stack

| Part | Choice | Why |
| --- | --- | --- |
| Language | TypeScript on Node 24, run directly (Node strips the types), no build step for servers | One language for the services, the script and the dashboard; the stack you already use |
| Ingest | `ingest/`: a small `node:http` service, no framework | It is the hot path; it stays tiny and scales on its own |
| Database | Postgres 17 on Render (Frankfurt), `pg` driver, plain SQL migrations | Simple to start; events are partitioned by month so it grows |
| Country lookup | DB-IP Country Lite (`.mmdb`, CC BY 4.0), downloaded at build time, read with `mmdb-lib` | Country only, offline, no third-party calls |
| Website script | `tracker/`: plain JS, minified with esbuild, served at `/s.js` | Under 10 KB |
| App SDK | `sdk/swift/`: a Swift package for macOS and iOS, no dependencies, sending to `/v1/app` | Notchlight first |
| Dashboard | `dashboard/`: accounts and a JSON API in the same `node:http` service as ingest; the app in `client/` is plain JS modules bundled by esbuild at start, in Onshipy's Shopify-admin style; the live globe uses d3-geo and world-atlas | One service to run; nothing loaded from other sites |
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
  `via` are kept), the referrer, the window width (for the device type) and optional props. While the page is in view
  it also checks in every 30 seconds (`_p`, for up to half an hour on one page) and says when the page closes (`_l`);
  those only stretch the open visit and move the visitor in or out of "right now" in memory, and are never stored.
- **Right now:** the visitors seen in the last 90 seconds who haven't closed the page, held in the ingest process's
  memory with the open visits and pushed to dashboards over server-sent events. With more than one instance this
  moves to a shared store.
- **Location:** the country is looked up from the IP in memory and stored with the visit. For the live globe only,
  the approximate city (its centre, from DB-IP's city database) is looked up too and held in memory with the open
  visit; it is never written to the database.
- **Exact location, by consent:** off unless a site's owner turns it on (`projects.ask_location`). Then the script
  asks with a card a few seconds in; only "Share" brings up the browser's geolocation prompt, and a visitor who has
  allowed it before shares without being asked again. "Not now" is remembered on the server for the visit
  (`/v1/site` tells the script whether to ask), so nothing is kept in the browser. The script sends the first fix and
  then sharper ones as GPS or Wi-Fi settles. The point, to about 10 metres, is held only with the visit in memory, and
  its address looked up from OpenStreetMap's Nominatim at most once a second. It is said only as exactly as the
  device was sure: the house number within 25 metres (and only if that building is as close), the street within
  100, otherwise the neighbourhood, because a wrong house number is worse than none. The live globe zooms to street
  level over OpenStreetMap's tiles. Without that consent there is no way to know a visitor's street: an IP address
  gives the city at best.
- **Bots:** dropped by user agent; automated browsers are skipped by the script.
- **Opting out:** site owners set `localStorage.statiku_ignore = "1"` in their own browser; the app SDK has an opt-out
  switch, which also forgets the install ID.
- **Apps:** an install is a random UUID the app makes on its first launch and keeps in its preferences. The SDK sends
  the platform, the OS and app versions, the build, the licence state and the events, nothing else. The IP is used for
  the country and the network hash below, then dropped.
- **Download marks:** each website download leaves `HMAC(salt_of_the_day, project + network)`, where the network is
  the IPv4 address or the IPv6 /64. Marks are deleted after 48 hours.

## Attribution: how each step finds its source

| Step | How it is linked | Kind |
| --- | --- | --- |
| Visit | UTM tags, then the referrer | exact |
| Download click | Same session as the visit (the script tracks clicks on `.dmg`, `.zip`, `.pkg`, `.exe` and links with `data-track`) | exact |
| Install | When the app first pings, it takes the latest untaken download mark from its network in the last 24 hours, hashed with today's or yesterday's salt, and copies that visit's source | estimate, shown as such |
| Trial, licensed | Reported by the SDK on the install | exact |
| Purchase on the website | The script adds `reference_id=stk_…` (Polar) or `client_reference_id=stk_…` (Stripe Payment Links) to checkout links when clicked, and records a `checkout` event with that ref. The webhook carries it back | exact |
| Purchase in the app | `Statiku.checkoutURL` adds a reference to the checkout link and records a `checkout` event with it on the install | exact, then through the install's source |

## Data model

Accounts (built):

- `users` (id, email, name, password_hash as scrypt)
- `workspaces` (id, name, plan): the billing unit; each person starts with one
- `memberships` (workspace, user, role)
- `logins` (hash of the cookie's token, user, expires_at): 30-day sign-ins
- `invites` (workspace, role, hash of the link's token, created_by, expires_at, accepted_by): links that work once, for a week
- `users.avatar` and `projects.icon`: a profile photo, and each site's own icon fetched by the server
- next: email verification, password reset and emailed invitations, once there's an email provider

Collection (built now):

- `projects` (id, workspace, public `key`, name, `domains[]` the script may report from, timezone): a website, an
  app, or both
- `salts` (day, salt): today's and yesterday's only
- `sessions` partitioned by month on `started_at`: visitor hash, started and last seen, entry and exit page, page views,
  events, source fields, country, device, browser, OS
- `events` partitioned by month on `ts`: name (`pageview` or a custom name), session, visitor, hostname, path, the
  session's source fields, country, device, browser, OS, props (jsonb), revenue (smallest unit + currency)
- `usage_daily` (project, day, events): for plan limits and billing

Apps (built):

- `installs` (project, random install ID, first and last seen, platform, app version, build, OS version, state: free,
  trial, expired or licensed, when trial and licensed were first reported, country, and the matched visit and its
  source fields)
- `download_marks` (project, network hash, time, session and its source, the install that took it): deleted after
  48 hours
- app events go into `events` with `install_id`, `app_version` and `os_version` set and the install's source copied
  on, so events by source work the same for both

Revenue (after that):

- `webhook_endpoints` (project, provider, signing secret)
- `purchases` (project, provider, provider order ID, time, amount, currency, reference, install, attributed source,
  status: paid or refunded)

## Plan

1. **Ingestion and the website script** (built; not yet deployed): `/e`, `/s.js`, sessions, country, devices, sources, custom events,
   checkout and download tracking, a CLI for projects and a stats report until the dashboard exists. Tested on
   notchlight.com's pages in Chrome, then live on notchlight.com.
2. **Swift SDK and app ingestion** (built; not yet in Notchlight): `/v1/app`, installs, active installs by version,
   trial and licensed state, opt-out, install attribution. Into Notchlight with the privacy page updated the same day.
3. **Revenue:** Polar and Stripe webhooks, attributed back to the source. Paddle, Lemon Squeezy and the App Store later.
4. **Accounts and dashboard** (built, apart from email): sign-up, workspaces, team invitations by link, adding a
   website without code knowledge, and per site: analytics with filters, custom periods and export, a live view with
   a globe, conversions, installs. Revenue by source comes with step 3.
5. **Billing:** a free tier, then paid plans by monthly events, through Polar.
6. **Launch:** a name and domain, the landing page, docs, privacy policy and DPA.
