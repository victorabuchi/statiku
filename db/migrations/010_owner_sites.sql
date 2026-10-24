-- Victor's own websites in his account, under the keys their pages carry: Knewler (p_wpmmdvjkej) and victorabuchi.com
-- (p_babgy4em4p). If he already added one of these domains himself, that site takes the key instead, so each domain
-- is one site. Nothing happens on a database without his account.
with owner as (
  select m.workspace_id as id from memberships m join users u on u.id = m.user_id
   where u.email = 'contact@victorabuchi.com' and m.role = 'owner' order by m.created_at limit 1),
wanted (key, name, domain) as (values ('p_wpmmdvjkej', 'Knewler', 'knewler.com'), ('p_babgy4em4p', 'Victor Abuchi', 'victorabuchi.com')),
rekeyed as (
  update projects p set key = w.key from wanted w, owner o
   where p.workspace_id = o.id and w.domain = any(p.domains) and p.key <> w.key and not exists (select 1 from projects x where x.key = w.key)
  returning p.id)
insert into projects (workspace_id, key, name, domains, timezone)
select o.id, w.key, w.name, array[w.domain], 'Europe/Helsinki' from owner o cross join wanted w
 where not exists (select 1 from projects p where p.workspace_id = o.id and w.domain = any(p.domains))
   and not exists (select 1 from projects p where p.key = w.key);
