-- Emails about a site: when it goes quiet (and is down, or lost Statiku's code), and when a rush of visitors arrives.
-- On unless its owner turns them off. alert_kind is the open alert (down, missing or quiet), if there is one.
alter table projects
  add column alert_quiet boolean not null default true,
  add column alert_surge boolean not null default true,
  add column alert_kind text,
  add column alert_since timestamptz,
  add column surge_at timestamptz;
