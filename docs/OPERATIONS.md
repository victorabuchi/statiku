# Running Statiku

What to set up once outside the code, and what to do when something goes wrong. Statiku runs on a free Oracle Cloud
server at `statiku.victorabuchi.com`: the service, its Postgres and Caddy (for HTTPS) in Docker, set up by
`deploy/oracle/first-boot.sh`. Extra settings (email, Google, Polar) go in `/opt/statiku/deploy/oracle/.env` on the
server, followed by `sudo /opt/statiku/deploy/oracle/update.sh --force`.

## Deploying on Oracle Cloud's Always Free tier

1. **Sign up** at oracle.com/cloud/free, with a **home region in Europe** (Frankfurt, Amsterdam, Stockholm…); it can't
   be changed later. Oracle checks a card. Then upgrade the account to **Pay As You Go**: it stays free while you use
   only Always Free resources, and spares the server from being reclaimed as idle, which happens to free-only accounts.
2. **Give the server read access to the code:** add the deploy key's public half to GitHub (`victorabuchi/statiku` →
   Settings → Deploy keys → Add, read-only), or with `gh repo deploy-key add <key>.pub -R victorabuchi/statiku`.
3. **Create the server:** Compute → Instances → Create instance.
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **VM.Standard.A1.Flex** (Ampere) with 1 OCPU and 6 GB; if Oracle says it's out of capacity, the
     **VM.Standard.E2.1.Micro** (AMD, 1 GB) works too, a little slower.
   - Networking: a new virtual cloud network with a public subnet, and a public IPv4 address.
   - SSH keys: let Oracle make a pair and save the private key; it's how you log in later.
   - Advanced options → Management → **cloud-init script**: paste `first-boot.sh` with the deploy key filled in.
4. **Open the web ports:** Networking → Virtual cloud networks → your network → its default security list → Add
   ingress rules: source `0.0.0.0/0`, TCP, destination port `80`; and the same for `443`.
5. **Point the address at it:** in Cloudflare's DNS for victorabuchi.com, an **A** record `statiku` → the server's
   public IP, with the proxy **off** (a grey cloud), so Caddy can get its certificate. If you turn the proxy on later,
   set `TRUST_PROXY=2` in the server's `.env`.
6. **Wait ten minutes or so** for the first build, then open `https://statiku.victorabuchi.com/healthz?deep=1`: it should
   say the database is answering and name the country you're in. Progress is in `/var/log/statiku-setup.log` on the
   server (`ssh -i <key> ubuntu@<ip>`).
7. **Sign up** at `https://statiku.victorabuchi.com` with contact@victorabuchi.com: the account is unlimited at once,
   with Notchlight, Knewler and victorabuchi.com already in it under the keys their pages carry.

From then on the server checks GitHub every five minutes and rebuilds Statiku after each push to main, and copies the
database every night to `/opt/statiku-backups` (the last 14). Notchlight, Knewler, victorabuchi.com and the Swift SDK
point at `statiku.victorabuchi.com`, so moving to another server later is only a new DNS record: the `Dockerfile` and
`deploy/oracle/compose.yaml` run on any machine with Docker.

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

The server copies the database every night to `/opt/statiku-backups` (`deploy/oracle/backup.sh`, the last 14). A copy
on the same server doesn't survive losing the server, so bring one home now and then:
`scp -i <key> ubuntu@<ip>:/opt/statiku-backups/<file> .`

Try a restore once a month, so you know it works before you need it:

1. On your Mac, `createdb statiku_restore && pg_restore --no-owner -d statiku_restore <file>`.
2. Compare it with the live database from the server, or just open it: every table should be there, with rows up to
   the night of the copy. `npm run restore-check -- "<url>"` compares two databases side by side.
3. Then `dropdb statiku_restore`.

When you really need it: restore the copy into the server's database
(`docker compose -f deploy/oracle/compose.yaml --env-file deploy/oracle/.env exec -T db pg_restore --clean --if-exists -U statiku -d statiku < <file>`)
and restart Statiku.

A host can suspend everything at once over a failed payment, as Render did in October 2026, so keep a card that works
on file, and a recent copy of the database somewhere else.
