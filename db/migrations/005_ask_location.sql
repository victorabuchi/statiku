-- Whether a site asks its visitors to share their exact location for its live view. Off unless its owner turns it
-- on; what visitors share is held only in memory while they're on the site.
alter table projects add column ask_location boolean not null default false;
