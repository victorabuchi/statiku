-- A fingerprint of each site's icon, so the icon's address changes when the icon does and browsers never keep an
-- old one; and sites where no icon was found are looked at again.
alter table projects add column icon_version text;
update projects set icon_version = left(md5(icon), 12) where icon is not null;
update projects set icon_checked_at = null where icon is null;
