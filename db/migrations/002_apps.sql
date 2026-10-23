-- Apps: one row per install, the download marks that link an install to the website visit it came from, and the
-- app's details on events.

-- An install is a random ID the app makes on its first launch and keeps until it is deleted or the user opts out.
create table installs (
  project_id uuid not null references projects on delete cascade,
  id uuid not null,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  platform text not null,
  app_version text,
  build text,
  os_version text,
  -- free, trial, expired or licensed, as the app last reported it, and when it first reported trial and licensed.
  state text,
  trial_at timestamptz,
  licensed_at timestamptz,
  country text,
  -- The website visit whose download it was matched to, and that visit's source. Null when nothing matched.
  session_id bigint,
  source text,
  referrer_host text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  primary key (project_id, id)
);

create index installs_project_first on installs (project_id, first_seen);
create index installs_project_last on installs (project_id, last_seen);
create index installs_project_session on installs (project_id, session_id) where session_id is not null;

-- A download click on the website, keyed by a hash of the network it came from, salted with that day's salt. An app
-- that first starts on the same network within a day takes the latest mark and is credited to its visit. Marks are
-- deleted after 48 hours, and their salts soon after, so they can't be traced back to a network.
create table download_marks (
  id bigint generated always as identity primary key,
  project_id uuid not null,
  network bigint not null,
  ts timestamptz not null,
  session_id bigint not null,
  source text not null,
  referrer_host text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  install_id uuid
);

create index download_marks_lookup on download_marks (project_id, network, ts);

-- Events from an app carry its install and versions; website events leave them empty.
alter table events add column install_id uuid, add column app_version text, add column os_version text;
