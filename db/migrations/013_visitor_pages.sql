-- A visitor's page views in order, for assists: the pages a visitor saw on the day, before a goal.
create index events_visitor_pages on events (project_id, visitor, ts) where name = 'pageview';
