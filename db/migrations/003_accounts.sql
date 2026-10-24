-- Accounts: the people who sign in to the dashboard, the workspaces they belong to, and their sign-ins.

create table users (
  id uuid primary key default gen_random_uuid(),
  -- Stored lower case.
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces on delete cascade,
  user_id uuid not null references users on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index memberships_user on memberships (user_id);
create index projects_workspace on projects (workspace_id);

-- A sign-in. The browser keeps a random token in a cookie; only the token's hash is stored here.
create table logins (
  token_hash bytea primary key,
  user_id uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index logins_user on logins (user_id);
