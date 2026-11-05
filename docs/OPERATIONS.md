# Running Statiku

What to set up once outside the code, and what to do when something goes wrong. Statiku runs on Northflank at
`statiku.victorabuchi.com`; every setting below goes in the service's environment there.

## Deploying on Northflank

Statiku is one service (the `Dockerfile` in this repository) and one Postgres database. The free Sandbox plan has
room for both; it may ask for a card to verify you.

1. Create a project, in a region in Europe.
2. Add a **PostgreSQL** addon on the smallest plan.
3. Add a **combined service** from the GitHub repository `victorabuchi/statiku`, branch `main`, built with the
   `Dockerfile`. Choose the 512 MB plan (nf-compute-20). With `GEO_CITY_DB=off` in its environment it fits in 256 MB,
   without cities on the live globe.
4. Under **Networking**, expose port `8080` over HTTP, publicly. Add a health check: HTTP `GET /healthz` on port 8080.
5. Under **Environment**:
   - `DATABASE_URL`: link it to the Postgres addon's connection string (its `POSTGRES_URI`). If the service then can't
     connect because of the certificate, add `?sslmode=no-verify` to the end of it.
   - `PUBLIC_URL`: `https://statiku.victorabuchi.com`
   - `SECRET_KEY`: any long random text, made once, such as the output of `openssl rand -base64 32` in Terminal.
     Keep it: it seals the tokens people give Statiku.
   - `TRUST_PROXY` is already 1 in the Dockerfile, for Northflank's proxy.
6. Under **Domains**, add `statiku.victorabuchi.com`. In Cloudflare's DNS for victorabuchi.com, add the CNAME record
   Northflank shows, with the proxy **off** (a grey cloud), so Northflank can issue its certificate. If you turn
   Cloudflare's proxy on later, set `TRUST_PROXY=2`.
7. Deploy. Migrations run before the service starts. Then sign up at https://statiku.victorabuchi.com with
   contact@victorabuchi.com: the account is unlimited at once, with Notchlight, Knewler and victorabuchi.com already in
   it under the keys their pages carry, and their visits start counting.

Notchlight, Knewler, victorabuchi.com and the Swift SDK already point at `statiku.victorabuchi.com`, so moving to
another host later is only a new CNAME record.

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
   `https://statiku.victorabuchi.com/api/imports/google/callback`.
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
3. Settings → Webhooks: add an endpoint at `https://statiku.victorabuchi.com/api/polar/webhook`, format Raw, for the
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
  Statiku answers again: one email each way, however long it lasts. For a check every minute or five, point a free
  monitor such as UptimeRobot or Better Stack at the same address.
- **Your customers' sites:** Statiku emails a site's owners when it goes quiet (and says whether it's down, lost its
  tracking code, or just has no visitors), when visits come back, and when a rush of visitors arrives. Each site can
  turn these off in its settings.

## Backups

Turn on scheduled backups for the Postgres addon in Northflank (its Backups page), if your plan has them, and keep a
copy of your own now and then: a backup only counts once you've restored one.

Try a restore once a month:

1. Restore the latest backup into a new Postgres addon.
2. In the service's shell, compare the copy with the live database:
   `npm run restore-check -- "<the new database's connection string>"`.
3. Every table should be there, with rows up to the backup. Then delete the new addon.

When you really need it: restore, check the copy the same way, then link the service's `DATABASE_URL` to the new
database and redeploy.

A host can suspend everything at once over a failed payment, as Render did in October 2026, so keep a card that works
on file, and a recent copy of the database somewhere else.
