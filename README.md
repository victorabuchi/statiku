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
- [x] Dashboard (runs locally, no sign-in yet): totals and trends, the journey by source, pages, countries, devices,
      events
- [ ] Swift package for macOS and iOS: installs, active installs by version, trial and licence state, opt-out
- [ ] Revenue from Polar and Stripe webhooks, credited to the source of the visit
- [ ] Accounts, team invites and plans, then the hosted dashboard

The full plan, the stack and the data model are in [docs/PLAN.md](docs/PLAN.md).

## Privacy

- **Nothing in the browser:** no cookies, no localStorage, no identifier sent.
- **No stored IPs:** an IP is used in memory to look up the country and build the visitor hash, then dropped.
- **Visitors can't be traced:** a visitor is a hash of the project, IP and browser, mixed with a secret that changes
  every day and is deleted after two days.
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
npm run seed         # 30 days of sample traffic to look at
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
```

## Project layout

| Folder | What's in it |
| --- | --- |
| `ingest/` | The service that serves the script (`/s.js`) and takes events (`/e`) |
| `dashboard/` | The dashboard page and its JSON API. Without sign-in it only listens on localhost |
| `tracker/` | The website script and its build |
| `db/` | Migrations and the migration runner |
| `scripts/` | Projects, the text report, sample traffic, the country database, the local Notchlight site and the browser test |
| `test/` | Unit and integration tests |

## Deploy

`render.yaml` is a Render Blueprint for the ingest service and Postgres, both in Frankfurt. Migrations run before
each deploy. Create projects from the service's Shell with `npm run project -- create …`. The dashboard stays local
until sign-in exists.

Country data: [IP Geolocation by DB-IP](https://db-ip.com), CC BY 4.0.
