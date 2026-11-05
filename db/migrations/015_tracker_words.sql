-- Trackers hold words and yes/no answers as well as numbers ("Online", "Sunny", the song playing): such a tracker
-- keeps its latest value, as text.
alter table metrics drop constraint metrics_kind_check;
alter table metrics add constraint metrics_kind_check check (kind in ('set', 'add', 'text'));
alter table metric_points alter column value drop not null, add column text_value text;
