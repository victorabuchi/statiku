-- History from before Statiku: what another analytics tool counted, or the download counts of GitHub releases. Kept
-- apart from what Statiku collects, as daily totals per breakdown value; the reports add it in for the days before
-- Statiku's own first event on the site.
create table imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  -- ga4, plausible, file or github.
  kind text not null,
  -- What was imported, in words: "Google Analytics: example.com (GA4 123456)".
  label text not null,
  -- running, done or failed.
  status text not null default 'running',
  error text,
  -- What a later refresh needs (a GitHub repository and the counts it last had), and a note for the person.
  config jsonb not null default '{}',
  note text,
  rows int not null default 0,
  first_day date,
  last_day date,
  created_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index imports_project on imports (project_id);

-- One day of one breakdown: dimension is total, source, page, entry, country, device, browser or os (or release and
-- releases for GitHub's downloads), and value the source, page, country… ('' for totals). `measured` is how many of
-- the visits had a known bounce and duration, so a tool that didn't report them doesn't dilute the rates.
create table imported_days (
  import_id uuid not null references imports on delete cascade,
  project_id uuid not null references projects on delete cascade,
  day date not null,
  dimension text not null,
  value text not null default '',
  visitors int not null default 0,
  visits int not null default 0,
  pageviews int not null default 0,
  bounces int not null default 0,
  duration bigint not null default 0,
  measured int not null default 0,
  downloads int not null default 0,
  primary key (import_id, dimension, value, day)
);

create index imported_days_report on imported_days (project_id, dimension, day);
