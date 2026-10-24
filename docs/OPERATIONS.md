# Running Statiku

What to set up once outside the code, and what to do when something goes wrong. Every setting below goes in the
`statiku-ingest` service's Environment on Render; the Blueprint (`render.yaml`) lists them all.

## Email

Password resets and site alerts are sent by email through any SMTP service. Brevo is in the EU and its free plan
sends 300 emails a day:

1. Create a Brevo account, add your domain under Senders & IP → Domains, and add the DNS records it shows (DKIM and
   DMARC), so the emails aren't taken for spam.
2. Under SMTP & API → SMTP, create an SMTP key.
3. Set `SMTP_URL` to `smtp://LOGIN:KEY@smtp-relay.brevo.com:587`, with the login and key Brevo shows. Write `@` in the
   login as `%40`.
4. Set `MAIL_FROM` to a sender on that domain, such as `Statiku <hello@yourdomain.com>`.

Without `SMTP_URL`, emails are only written to the service's log.

## Importing from Google Analytics

People sign in with Google and pick a GA4 property. This needs an OAuth client of your own:

1. In [Google Cloud](https://console.cloud.google.com/), create a project, then under APIs & Services → Library
   enable the **Google Analytics Data API** and the **Google Analytics Admin API**.
2. Configure the OAuth consent screen (Google Auth Platform): External, with Statiku's name, a support email, and the
   scope `https://www.googleapis.com/auth/analytics.readonly`.
3. Under Clients, create an OAuth client of type Web application, with this authorized redirect URI:
   `https://statiku-ingest.onrender.com/api/imports/google/callback` (your own domain instead, once `PUBLIC_URL` is set).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

While the app is in Testing, only the test users you list (up to 100) can sign in. `analytics.readonly` is a sensitive
scope, so before everyone can use it Google reviews the app: it asks for a privacy policy on your domain and a short
video of the sign-in. Until then, anyone can import a CSV downloaded from Google Analytics instead.

## Plans and payments (Polar)

Statiku's plans are sold through [Polar](https://polar.sh), as Notchlight is. Polar is the merchant of record, so it
charges VAT and sends receipts.

1. In Polar, create a subscription product for each plan and period you sell, at the prices in
   `dashboard/billing.ts` (Starter €9 a month or €90 a year, Growth €19 or €190, Business €69 or €690, Scale €199 or
   €1,990). Change the prices in both places if you change them.
2. Settings → Developers: create an organization access token with `checkouts:write` and `customer_sessions:write`.
   Set it as `POLAR_ACCESS_TOKEN`.
3. Settings → Webhooks: add an endpoint at `https://statiku-ingest.onrender.com/api/polar/webhook`, format Raw, for the
   `subscription.*` events. Set its secret as `POLAR_WEBHOOK_SECRET`.
4. Set `POLAR_PRODUCTS` to each product's ID, such as
   `starter:month=…,starter:year=…,growth:month=…,growth:year=…,business:month=…,business:year=…,scale:month=…,scale:year=…`.
   A plan without a product shows "Not on sale yet".

To try it without real money, use Polar's sandbox: its own token, webhook and products, and
`POLAR_API=https://sandbox-api.polar.sh`.

Every new workspace has a 30-day trial. When it ends without a plan, the reports close and Statiku keeps counting.
By hand, in the service's Shell:

```sh
npm run billing -- comp someone@example.com       # free and unlimited (contact@victorabuchi.com already is)
npm run billing -- trial someone@example.com 14   # the trial ends 14 days from now
npm run billing -- show someone@example.com
```

## Knowing when it's down

- **Statiku itself:** GitHub checks `/healthz?deep=1` every half hour (`.github/workflows/uptime.yml`). When it doesn't
  answer three times in a row, an issue labelled `down` is opened, and GitHub emails it to you; it's closed when
  Statiku answers again. Render also emails you when the service crashes or fails its health check. For a check every
  minute or five, point a free monitor such as UptimeRobot or Better Stack at the same address.
- **Your customers' sites:** Statiku emails a site's owners when it goes quiet (and says whether it's down, lost its
  tracking code, or just has no visitors), when visits come back, and when a rush of visitors arrives. Each site can
  turn these off in its settings.

## Backups

The database (Render Postgres, basic-256mb) keeps its own history: Render can restore it to any moment in the last 3
days on the Hobby workspace plan, or 7 days on Pro. A restore makes a new database and leaves the old one alone. On top
of that, the database's Recovery page makes an export on demand, kept for 7 days.

Try a restore once a month, so you know it works before you need it:

1. In Render, open `statiku-db` → Recovery → restore to a point in time, an hour ago. Render creates a new database.
2. In the `statiku-ingest` service's Shell, compare the copy with the live database:
   `npm run restore-check -- "<the new database's internal URL>"`.
3. Every table should be there, with rows up to the moment you chose. Then delete the new database.

When you really need it: restore to just before the problem, check the copy the same way, then point the service's
`DATABASE_URL` at the new database and redeploy.
