-- Run once in the Supabase SQL editor. One row per linked Discord user.
create table if not exists ecc00_links (
  token      text primary key,
  discord_id text unique not null,
  username   text,
  avatar     text,
  created_at timestamptz default now()
);
-- Service-role key only (the bot). No public/anon access to this table.
alter table ecc00_links enable row level security;
