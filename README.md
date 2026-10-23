# Statiku

Privacy-first analytics for websites and the apps you sell yourself. Statiku shows which sources bring the visits,
the downloads, the installs and the sales, with no cookies, no stored IP addresses, and data kept in the EU.

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
      checkout clicks that carry a reference to the payment. Under 2 KB, no cookies.
- [x] Ingest service: sessions, daily-rotating visitor hashes, batched writes to Postgres partitioned by month
- [x] Swift package for macOS and iOS: an anonymous install, the days it's used, versions, trial and licence state,
      custom events and an opt-out. Each install is credited to the website visit it was downloaded from.
- [x] Dashboard (runs locally, no sign-in yet): totals and trends, the journey by source from visit to licence, pages,
      countries, devices, events, and the app's installs, versions and licences
- [ ] Revenue from Polar and Stripe webhooks, credited to the source of the visit
- [ ] Accounts, team invites and plans, then the hosted dashboard

The full plan, the stack and the data model are in [docs/PLAN.md](docs/PLAN.md).

## Privacy

- **Nothing in the browser:** no cookies, no localStorage, no identifier sent.
- **No stored IPs:** an IP is used in memory to look up the country and build the visitor hash, then dropped.
- **Visitors can't be traced:** a visitor is a hash of the project, IP and browser, mixed with a secret that changes
  every day and is deleted after two days.
- **Apps send no personal data:** an install is a random ID kept in the app's preferences, with no account, name or
  hardware ID. Its IP is used for the country and to match the install to a download from the same network, then
  dropped. The app can offer an opt-out.
- **Data stays in the EU:** the service and its database run in Frankfurt.

## Add it to a website

```html
<script defer data-project="p_…" src="https://<ingest host>/s.js"></script>
```

Page views count on their own, including single-page navigation. Clicks on files (.dmg, .zip, .exe and so on) send
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

## Run it locally

Needs Node 24 or later and Postgres.

```sh
cp .env.example .env
createdb statiku && createdb statiku_test
npm install
npm run geo          # DB-IP's country database, into data/
npm run migrate
npm run dev          # the ingest service, http://localhost:8787
npm run dashboard    # the dashboard, http://localhost:8788
npm run seed         # 30 days of sample traffic and installs to look at
npm run notchlight   # Notchlight's site with the script, http://localhost:8790
```

Projects are created from the command line until accounts exist:

```sh
npm run project -- create "My site" example.com --timezone Europe/Helsinki
npm run stats -- <project key>   # a text report
```

## Tests

```sh
npm test         # unit tests and the ingest service against Postgres (uses statiku_test and empties it)
npm run e2e      # the script on Notchlight's real pages in Chrome; needs Chrome Canary and ../notchlight
npm run build    # minifies the script and fails over 2 KB
cd sdk/swift && swift test   # the Swift package
```

With the ingest service running, the Swift package's live test sends a real install to it:
`STATIKU_TEST_ENDPOINT=http://127.0.0.1:8787 STATIKU_TEST_PROJECT=p_… swift test --filter liveService`.

## Project layout

| Folder | What's in it |
| --- | --- |
| `ingest/` | The service that serves the script (`/s.js`) and takes events from websites (`/e`) and apps (`/v1/app`) |
| `dashboard/` | The dashboard page and its JSON API. Without sign-in it only listens on localhost |
| `tracker/` | The website script and its build |
| `sdk/swift/` | The Swift package for Mac, iPhone and iPad apps |
| `db/` | Migrations and the migration runner |
| `scripts/` | Projects, the text report, sample traffic and installs, the country database, the local Notchlight site and the browser test |
| `test/` | Unit and integration tests |

## Deploy

`render.yaml` is a Render Blueprint for the ingest service and Postgres, both in Frankfurt. Migrations run before
each deploy. Create projects from the service's Shell with `npm run project -- create …`. The dashboard stays local
until sign-in exists.

Country data: [IP Geolocation by DB-IP](https://db-ip.com), CC BY 4.0.
