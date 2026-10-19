# Waymark

Privacy-first analytics for websites and apps, from the first visit to the purchase: which source brought the visit,
the download, the install and the sale. No cookies, no stored IPs, data in the EU. Waymark is a working name.

The plan, the stack and the data model are in [docs/PLAN.md](docs/PLAN.md).

## What's here

- `ingest/`: the service that serves the website script (`/s.js`) and takes events (`/e`)
- `tracker/src/script.js`: the website script, under 2 KB minified
- `db/migrations/`: the schema
- `scripts/`: `project` (create projects), `stats` (a text report), `geo` (the country database), `e2e-notchlight` (the script on Notchlight's pages in Chrome)

## Run it locally

Needs Node 24 or later and Postgres.

```sh
cp .env.example .env
createdb waymark && createdb waymark_test
npm install
npm run geo        # DB-IP's country database, to data/
npm run migrate
npm run project -- create "My site" example.com --timezone Europe/Helsinki
npm run dev        # http://localhost:8787
npm test
npm run e2e        # needs Chrome Canary and ../lockwidgets
npm run stats -- <project key>
```

## Add it to a website

```html
<script defer data-project="p_…" src="https://<ingest host>/s.js"></script>
```

Page views are counted on load and on single-page navigation. Clicks on files (.dmg, .zip, .exe…) send `download`;
clicks on Polar or Stripe checkout links send `checkout` and carry a reference to the payment. Anything else:

```html
<a href="/pricing" data-track="pricing" data-track-from="hero">Pricing</a>
<script>
  window.waymark = window.waymark || function () { (waymark.q = waymark.q || []).push(arguments) };
  waymark("signup", { props: { plan: "pro" } });
</script>
```

To leave your own visits out, run `localStorage.waymark_ignore = "1"` in your browser's console on your site.

## Deploy

`render.yaml` is a Render Blueprint: the ingest service and Postgres in Frankfurt. Migrations run before each deploy.
Create projects from the service's Shell with `npm run project -- create …`.

Country data: [IP Geolocation by DB-IP](https://db-ip.com), CC BY 4.0.
