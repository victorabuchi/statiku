-- Payments a site's customers made, as its Stripe or Polar webhook reported them: only their ids, so a payment
-- delivered twice (they retry) is counted once. The payment itself is an event, "purchase", with what it earned.
create table payments (
  project_id uuid not null references projects on delete cascade,
  provider text not null,
  id text not null,
  at timestamptz not null default now(),
  primary key (project_id, provider, id)
);
