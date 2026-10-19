-- Workspaces and projects, and the tables the ingest service writes. Accounts (users, memberships, invites) come
-- with the dashboard.

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

-- A website, an app, or both. `key` is public: it goes in the script tag and the SDK.
create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  key text not null unique,
  name text not null,
  -- Hostnames the website script may report from; subdomains count too.
  domains text[] not null default '{}',
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

-- One random salt per UTC day for the visitor hash. Only today's and yesterday's are kept, so a hash can never be
-- traced back to an IP once its salt is gone.
create table salts (
  day date primary key,
  salt bytea not null
);

-- A visitor's events with gaps under 30 minutes. The source fields come from the session's first event.
create table sessions (
  project_id uuid not null,
  id bigint not null,
  visitor bigint not null,
  started_at timestamptz not null,
  last_seen timestamptz not null,
  entry_path text,
  exit_path text,
  pageviews integer not null default 0,
  events integer not null default 0,
  source text not null,
  referrer_host text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  country text,
  device text,
  browser text,
  os text,
  primary key (project_id, id, started_at)
) partition by range (started_at);

create index sessions_project_started on sessions (project_id, started_at);
create index sessions_visitor on sessions (project_id, visitor, last_seen);

-- Every page view and custom event. The source fields are the session's, so counting any event by source is a
-- plain group by.
create table events (
  project_id uuid not null,
  ts timestamptz not null,
  name text not null,
  session_id bigint,
  visitor bigint,
  hostname text,
  path text,
  source text,
  referrer_host text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  country text,
  device text,
  browser text,
  os text,
  props jsonb,
  -- In the currency's smallest unit, as Stripe and Polar send it.
  revenue_minor bigint,
  currency text
) partition by range (ts);

create index events_project_ts on events (project_id, ts);
create index events_project_name_ts on events (project_id, name, ts);

-- Events accepted per project per day, for plan limits.
create table usage_daily (
  project_id uuid not null references projects on delete cascade,
  day date not null,
  events bigint not null default 0,
  primary key (project_id, day)
);

-- Monthly partitions for a partitioned table, from `months_back` before this month to `months_ahead` after it.
-- The ingest service calls it at start and every few hours.
create function ensure_month_partitions(parent text, months_back int, months_ahead int) returns void
language plpgsql as $$
declare
  m timestamp;
begin
  for i in -months_back..months_ahead loop
    -- Month bounds in UTC, whatever the session's time zone.
    m := date_trunc('month', now() at time zone 'utc') + make_interval(months => i);
    execute format(
      'create table if not exists %I partition of %I for values from (%L) to (%L)',
      parent || '_' || to_char(m, 'YYYY_MM'), parent, m at time zone 'utc', (m + interval '1 month') at time zone 'utc'
    );
  end loop;
end $$;

select ensure_month_partitions('events', 1, 2);
select ensure_month_partitions('sessions', 1, 2);
