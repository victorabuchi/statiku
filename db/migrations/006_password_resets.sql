-- A link that lets someone who forgot their password choose a new one. Only the token's hash is kept; it works once,
-- for an hour.
create table password_resets (
  token_hash bytea primary key,
  user_id uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index password_resets_user on password_resets (user_id);
