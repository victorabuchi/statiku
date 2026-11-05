# Statiku

Live analytics for websites, SaaS and apps. Statiku shows who is on your site right now, where they came from, and
which sources bring the visits, the sign-ups, the downloads, the installs and the sales, and it tracks anything else
a site sends, charted any way you like. The data is kept in the EU. Exact location only for visitors who opt in.

```
visit  →  download  →  install  →  trial  →  purchase
  website script         app SDK            Polar / Stripe webhook
```

Website analytics tools stop at the website and app analytics tools start inside the app. Statiku follows one journey
across both, so you can see, for example, that Hacker News brought the most visits but MacNative brought the most
sales.

Notchlight ([notchlight.com](https://notchlight.com)) is the first customer.

## Status

- [x] Website script: page views, sources and campaigns, countries, devices, custom events, download clicks, and
      checkout clicks that carry a reference to the payment. Under 10 KB, no cookies.
- [x] Ingest service: sessions, daily-rotating visitor hashes, batched writes to Postgres partitioned by month
- [x] Swift package for macOS and iOS: an anonymous install, the days it's used, versions, trial and licence state,
      custom events and an opt-out. Each install is credited to the website visit it was downloaded from.
- [x] Accounts and the dashboard, served by the same service: sign up, add a website by its address with steps for
      WordPress, Shopify, Wix, Squarespace, Webflow, Framer and Tag Manager, and an installation check; analytics
      against the previous period, filters on any breakdown, custom periods and CSV export; sources, pages, locations,
      devices, conversions, events and campaigns, by hour, day, week, month or year, back to the first visit; a live
      view with a globe that changes the moment someone arrives or leaves and zooms in to countries and cities; the app's installs, versions and licences; each site's own icon; account settings, a profile photo and
      team invitations by link
- [x] History from before Statiku: Google Analytics (signing in with Google), Plausible (an API key), GitHub
      release downloads (refreshed every six hours) and files from any other tool (CSV or ZIP). Imported days count
      only before Statiku's own first event, never twice, and never in filtered reports.
- [x] Plans through Polar: a 30-day trial, then four plans by events a month; checkout, the billing portal and signed
      webhooks. After an unpaid trial the reports close while counting goes on.
- [x] Email through any SMTP service: password resets, and alerts when a site goes quiet (down, its code gone, or just
      quiet), when visits come back, and when a rush of visitors arrives
- [x] Statiku's own pages: a landing page with a film of real screens, pricing, terms, privacy policy and a data
      processing agreement
- [ ] Revenue from Polar and Stripe webhooks, credited to the source of the visit
- [ ] Email verification, and invitations sent by email

The full plan, the stack and the data model are in [docs/PLAN.md](docs/PLAN.md).

## Visitors' data

- **Nothing in the browser:** no cookies, no localStorage, no identifier sent.
- **Live, not tracked:** while a page is in view, the script checks in every 30 seconds (for up to half an hour) and
  says when the page closes. That keeps the live view and visit lengths right; check-ins are never stored as events.
- **No stored IPs:** an IP is used in memory to look up the country and build the visitor hash, then dropped.
- **Cities only while live:** the live globe places visitors in their approximate city while they're on the site.
  The city is held in memory and never stored; the reports keep only the country.
- **Exact location only by choice:** a site can turn on a setting (off by default) that asks its visitors, with a
  card and then the browser's own prompt, to share their location. Those who agree show at their address in the
  live view while they're on the site, with the house number only when their device is sure of it to within 25
  metres. The point, to about 10 metres, is never stored, and its address comes from OpenStreetMap.
- **Visitors can't be traced:** a visitor is a hash of the project, IP and browser, mixed with a secret that changes
  every day and is deleted after two days.
- **Apps send no personal data:** an install is a random ID kept in the app's preferences, with no account, name or
  hardware ID. Its IP is used for the country and to match the install to a download from the same network, then
  dropped. The app can offer an opt-out.
- **Data stays in the EU:** the service and its database run in Stockholm, Sweden.

## Add it to a website

```html
<script defer data-project="p_…" src="https://statiku.victorabuchi.com/s.js"></script>
```

Page views count on their own, including single-page navigation, and the live view shows a visitor the moment they
arrive. Clicks on files (.dmg, .zip, .exe and so on) send
`download`. Clicks on Polar or Stripe checkout links send `checkout`, and the link gets a reference that the payment
webhook brings back. For anything else:

```html
<a href="/pricing" data-track="pricing" data-track-from="hero">Pricing</a>
<script>
  window.statiku = window.statiku || function () { (statiku.q = statiku.q || []).push(arguments) };
  statiku("signup", { props: { plan: "pro" } });
</script>
```

To leave your own visits out, run `localStorage.statiku_ignore = "1"` in your browser's console on your site.

The script also notes, for the site's **Heatmaps**, where clicks land on a page and how far down each visit read, and
for its **Injuries**, how fast each page loaded for the visitor (Core Web Vitals), the status the page came with, and
its first few script errors. Nothing records the screen, and none of it counts as an event. `data-lite` on the script
tag turns these off and keeps page views and events only.

## Add it to an app

The Swift package is in `sdk/swift` (macOS 12, iOS 15 and later). Until it has its own repository, add it to an
Xcode project as a local package.

```swift
import Statiku

// When the app launches. Pass endpoint: to send somewhere other than Statiku's service.
Statiku.start(project: "p_…")

// Whenever the licence may have changed: .trial, .expired, .licensed or .free
Statiku.setState(.trial)

// Your own events
Statiku.track("export", ["format": "png"])

// Checkout links opened from the app, so the purchase is credited to the install's source
NSWorkspace.shared.open(Statiku.checkoutURL(buyURL))

// An opt-out in the app's settings: nothing more is sent, and the install ID is forgotten
Statiku.isOptedOut = true
```

The first launch sends `install`, each day the app runs sends `active`, and a new version sends `update`. Events wait
in the app's preferences while it's offline and go in batches.

An install is matched to the website by its network: when the app first starts, it takes the latest download click
from the same network in the day before, and gets that visit's source. Installs with no download before them (Homebrew,
another network, a link passed on) show as not matched. The match is an estimate, and the dashboard says so.

## Trackers: track anything

Anything a site measures beyond its visits (match scores, installs, sales, sensor readings) can be sent from a script,
a server or a device, with the secret key from the site's **Numbers** page, and shows there as a live tile:

```sh
curl https://statiku.victorabuchi.com/v1/number \
  -H "Authorization: Bearer sn_…" \
  -d '{"name": "Home goals", "value": 2}'
```

`"op": "add"` makes a number that counts up (each value is added to its total); any other keeps its latest value.
`"ts"` (ISO time or Unix seconds) sends a value from another time, a body can hold a list of up to 100, and a device
that can only open an address can use `/v1/number?key=…&name=…&value=…`. Numbers also come in CSV files on the same
page: `time,name,value` rows, or a `time` column and a column for each number. They count towards the site's events.

## Run it locally

Needs Node 24 or later and Postgres.

```sh
cp .env.example .env
createdb statiku && createdb statiku_test
npm install
npm run geo          # DB-IP's country and city databases, into data/ (the city one is 130 MB, for the live globe)
npm run migrate
npm run dev          # the service and the dashboard, http://localhost:8787
```

Open http://localhost:8787, create an account and add a website. From the command line:

```sh
npm run project -- list
npm run project -- move <project key> you@example.com   # a project made here into your account
npm run stats -- <project key>                          # a text report
```

## Tests

```sh
npm test         # unit tests, the ingest service and the dashboard's API against Postgres (uses statiku_test and empties it)
npm run e2e      # the script on Notchlight's real pages in Chrome; needs Chrome Canary and ../notchlight; cleans up after
npm run build    # minifies the script and fails over 10 KB
cd sdk/swift && swift test   # the Swift package
```

With the ingest service running, the Swift package's live test sends a real install to it:
`STATIKU_TEST_ENDPOINT=http://127.0.0.1:8787 STATIKU_TEST_PROJECT=p_… swift test --filter liveService`.

## Project layout

| Folder | What's in it |
| --- | --- |
| `ingest/` | The service: the script (`/s.js`), events from websites (`/e`) and apps (`/v1/app`), and the dashboard at every other address |
| `dashboard/` | Accounts, the dashboard's API (`/api`), imports, plans, alerts and email; `client/` is the app, bundled when the service starts |
| `site/` | Statiku's own pages: the landing page and its film (pictures made by `scripts/shots.ts`), terms, privacy, DPA |
| `tracker/` | The website script and its build |
| `sdk/swift/` | The Swift package for Mac, iPhone and iPad apps |
| `db/` | Migrations and the migration runner |
| `scripts/` | Projects, plans by hand, the text report, the location databases, demo data, the film's pictures, the restore check and the browser test |
| `test/` | Unit and integration tests |

## Deploy

Statiku runs on a free Oracle Cloud server in Stockholm at `statiku.victorabuchi.com`: the `Dockerfile`'s service, Postgres and
Caddy in Docker (`deploy/oracle/`), rebuilt after each push to main; migrations run before the service starts. [docs/OPERATIONS.md](docs/OPERATIONS.md) has the steps, sets up email,
Google sign-in for imports and Polar for payments, and covers alerts, backups and the monthly restore drill.
`render.yaml` is the Render Blueprint it ran on until October 2026.

The film on the landing page plays real screens on demo data. After a change to the dashboard, take its pictures
again with `DATABASE_URL=postgres://localhost/statiku_demo node scripts/shots.ts` (it needs Chrome). A project made in the service's Shell before accounts
existed goes into an account with `npm run project -- move <key> <email>`, after that person signs up.

Location data: [IP Geolocation by DB-IP](https://db-ip.com), CC BY 4.0.
