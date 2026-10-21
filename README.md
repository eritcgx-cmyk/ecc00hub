# ECC00 hub service

One Node app: Discord bot + web "Get Script" panel + Discord↔Roblox link store + profile API.

## What it does
- **Website panel** (`/`): minimal black page with **Get Script** → Discord OAuth → shows a personalized loadstring.
- **Personalized loadstring** (`/s/:token`): the normal hub loader with the viewer's token baked in. The script then shows their Discord **name + avatar** in the menu profile frame (role badge still comes from `roles.json`).
- **Profile API** (`/api/profile?token=…`): what the Lua reads to fill the profile.
- **Discord bot**: `/panel` (ManageGuild) posts the **Free Scripts** button panel; a button or `/getscript` DMs the user their personalized loadstring. Games live in `games.js`.

## Setup (once)
1. **Supabase**: run `schema.sql` in the SQL editor (creates `ecc00_links`).
2. **Discord app** (discord.com/developers): a bot application. Copy the **Client ID**, **Client Secret**, **Bot Token**. Under OAuth2 → Redirects, add `https://<your-render-url>/auth/callback`. Invite the bot to your server with `applications.commands` + `bot`.
3. **Render**: deploy this folder (render.yaml). Set env vars in the dashboard:
   - `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `PUBLIC_URL` = the service's own https url (e.g. `https://ecc00hub.onrender.com`)
   - `HUB_LOADER` defaults to `https://eccohub.xyz/loader.lua`
4. Point `eccohub.xyz` "Get Script" at `https://<render-url>/` (or add a Vercel redirect).

Secrets are only ever set in the dashboard — none are committed.

## Local run
`npm install` then `PUBLIC_URL=http://localhost:10000 DISCORD_CLIENT_ID=… node index.js`. Web works without a bot token (bot stays offline).
