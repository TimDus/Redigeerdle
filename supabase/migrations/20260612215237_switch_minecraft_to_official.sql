-- ============================================================================
--  Minecraft left Fandom for the official community wiki at minecraft.wiki.
--  It's the same MediaWiki software (api.php works, CORS is "*", so the browser
--  can live-fetch it), and it's a far better source. Switch the pool entry from
--  the Fandom host to the real one. No FK references wikis.host, so renaming the
--  primary key just repoints the pool; old minecraft.fandom.com puzzles/picks
--  stay as harmless history.
-- ============================================================================
update public.wikis
set host = 'minecraft.wiki',
    display_name = 'Minecraft',
    icon = 'https://www.google.com/s2/favicons?domain=minecraft.wiki&sz=64'
where host = 'minecraft.fandom.com';

-- Add two more non-Fandom MediaWiki sites to the pool. The client + picker probe
-- /api.php vs /w/api.php, so Wikipedia (which uses /w/api.php) works too.
insert into public.wikis (host, enabled, display_name, icon) values
  ('wiki.guildwars2.com', true, 'Guild Wars 2', 'https://www.google.com/s2/favicons?domain=wiki.guildwars2.com&sz=64'),
  ('en.wikipedia.org',    true, 'Wikipedia',    'https://www.google.com/s2/favicons?domain=en.wikipedia.org&sz=64')
on conflict (host) do nothing;
