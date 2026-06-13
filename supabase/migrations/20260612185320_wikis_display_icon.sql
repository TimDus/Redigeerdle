-- ============================================================================
--  wikis: add a human display name and a small icon for the fandom picker.
--  `icon` is free text: an image URL (the client renders an <img>) or an emoji.
--  Here we seed real per-community favicons via Google's favicon service — a
--  square PNG that's distinct per wiki and always loads (Fandom blocks direct
--  /favicon.ico hotlinking with 403). Both columns are optional; the client
--  falls back to the bare host name and a host-derived favicon when they're null,
--  so wikis added later still get an image. Edit any row to override.
-- ============================================================================
alter table public.wikis add column if not exists display_name text;
alter table public.wikis add column if not exists icon text;

-- display names for the current pool (idempotent: only sets matching hosts)
update public.wikis as w set display_name = v.display_name
from (values
  ('anbennar.fandom.com',           'Anbennar'),
  ('avatar.fandom.com',             'Avatar: The Last Airbender'),
  ('dc.fandom.com',                 'DC Comics'),
  ('disney.fandom.com',             'Disney'),
  ('dragonage.fandom.com',          'Dragon Age'),
  ('elderscrolls.fandom.com',       'The Elder Scrolls'),
  ('fallout.fandom.com',            'Fallout'),
  ('finalfantasy.fandom.com',       'Final Fantasy'),
  ('godofwar.fandom.com',           'God of War'),
  ('halo.fandom.com',               'Halo'),
  ('harrypotter.fandom.com',        'Harry Potter'),
  ('kingdomhearts.fandom.com',      'Kingdom Hearts'),
  ('leagueoflegends.fandom.com',    'League of Legends'),
  ('lotr.fandom.com',               'The Lord of the Rings'),
  ('marvel.fandom.com',             'Marvel Comics'),
  ('masseffect.fandom.com',         'Mass Effect'),
  ('memory-alpha.fandom.com',       'Star Trek'),
  ('minecraft.fandom.com',          'Minecraft'),
  ('naruto.fandom.com',             'Naruto'),
  ('oldschoolrunescape.fandom.com', 'Old School RuneScape'),
  ('onepiece.fandom.com',           'One Piece'),
  ('pokemon.fandom.com',            'Pokémon'),
  ('residentevil.fandom.com',       'Resident Evil'),
  ('starwars.fandom.com',           'Star Wars'),
  ('witcher.fandom.com',            'The Witcher'),
  ('zelda.fandom.com',              'The Legend of Zelda')
) as v(host, display_name)
where w.host = v.host;

-- icons: the community favicon, fetched server-side by Google and served as a
-- square PNG. Only fills empty icons, so a manually-set custom image is kept.
update public.wikis
set icon = 'https://www.google.com/s2/favicons?domain=' || host || '&sz=64'
where icon is null;

-- a custom icon for Anbennar (no recognisable favicon), hosted in Storage
update public.wikis
set icon = 'https://obijqgumdkuzefhggflx.supabase.co/storage/v1/object/public/wiki-icons/anbennar.webp'
where host = 'anbennar.fandom.com';
