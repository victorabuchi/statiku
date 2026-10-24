-- Paying for Statiku, per workspace: a 30-day trial, then a plan bought through Polar. `plan` is free (no plan), a
-- plan's id (starter, growth…), or comp for one given for free. The rest mirrors the Polar subscription.
alter table workspaces
  add column trial_ends_at timestamptz,
  add column subscription_id text,
  add column subscription_status text,
  add column period_end timestamptz,
  add column cancel_at_period_end boolean not null default false,
  add column polar_customer_id text,
  -- When Polar sent the state kept here, so an older delivery can't undo a newer one.
  add column billing_updated_at timestamptz;

-- Workspaces made before billing get their trial from now on.
update workspaces set trial_ends_at = now() + interval '30 days';

-- Statiku's own account (Victor's, with Notchlight) is unlimited and never billed.
update workspaces set plan = 'comp'
 where id in (select m.workspace_id from memberships m join users u on u.id = m.user_id
               where u.email = 'contact@victorabuchi.com' and m.role = 'owner');
alter table workspaces alter column trial_ends_at set default now() + interval '30 days';
