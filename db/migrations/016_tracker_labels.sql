-- A tracker's values can carry labels ({"plan": "pro", "country": "FI"}), so any tracker can be split by them: sales
-- by plan, readings by room, sign-ups by country.
alter table metric_points add column props jsonb;
