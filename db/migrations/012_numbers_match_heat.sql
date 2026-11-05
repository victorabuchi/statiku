-- What a site measures beyond its visits.
--   Numbers: anything sent with the site's secret key, from a script, a server or a device, or uploaded in a file:
--   match scores, installs, sensor readings, revenue. "set" numbers keep their latest value (a score, a temperature);
--   "add" numbers count up (installs, sales).
--   Heatmaps: where visitors click on a page and how far down they read it.
--   Injuries: how fast pages load for real visitors, the errors they hit, and pages that answer with an error.
-- And how a site shares and reports on itself: the match view's public link, the weekly match report (by email, and
-- to Slack if it's given a webhook), the events that count as goals, and its payment providers' webhook secrets, so a
-- payment is credited to the visit that led to it.
alter table projects
  add column numbers_key_hash text,
  add column match_token text unique,
  add column goals text[],
  add column report_weekly boolean not null default true,
  add column slack_webhook text,
  add column report_week date,
  add column stripe_secret text,
  add column polar_secret text;

create table metrics (
  project_id uuid not null references projects on delete cascade,
  name text not null,
  kind text not null default 'set' check (kind in ('set', 'add')),
  created_at timestamptz not null default now(),
  primary key (project_id, name)
);

create table metric_points (
  project_id uuid not null,
  name text not null,
  ts timestamptz not null,
  value double precision not null
);
create index metric_points_by_name on metric_points (project_id, name, ts);

-- A click's place on the page: x as a share of the page's width (pages reflow), y in pixels from the top, with the
-- page's height and the text of the link or button clicked, if it was one.
create table clicks (
  project_id uuid not null,
  ts timestamptz not null,
  path text not null,
  device text,
  x real not null,
  y integer not null,
  page_h integer,
  target text
);
create index clicks_by_page on clicks (project_id, path, ts);

-- How far down a page a visit read, in percent, when the page closed.
create table scrolls (
  project_id uuid not null,
  ts timestamptz not null,
  path text not null,
  device text,
  depth smallint not null
);
create index scrolls_by_page on scrolls (project_id, path, ts);

-- A page view's Core Web Vitals (milliseconds, and layout shift as a score), and the HTTP status the page came with.
create table vitals (
  project_id uuid not null,
  ts timestamptz not null,
  path text not null,
  device text,
  lcp integer,
  inp integer,
  cls real,
  ttfb integer,
  status smallint
);
create index vitals_by_site on vitals (project_id, ts);

create table page_errors (
  project_id uuid not null,
  ts timestamptz not null,
  path text,
  message text not null,
  source text,
  line integer,
  browser text
);
create index page_errors_by_site on page_errors (project_id, ts);

-- A payment comes back with the reference its checkout link was given; this finds the checkout, and so its visit.
create index events_checkout_ref on events ((props ->> 'ref')) where name = 'checkout';
