-- Each site's icon, fetched from the site itself; a profile photo for each person; and invitations to a workspace.

alter table projects add column icon bytea, add column icon_type text, add column icon_checked_at timestamptz;

alter table users add column avatar bytea, add column avatar_type text, add column avatar_at timestamptz;

-- A link that adds whoever opens it to a workspace. Only the token's hash is kept; it works once, for a week.
create table invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  token_hash bytea not null unique,
  role text not null default 'member',
  created_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_by uuid references users on delete set null,
  accepted_at timestamptz
);

create index invites_workspace on invites (workspace_id);
