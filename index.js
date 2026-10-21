// ECC00 hub service: Discord bot + web "Get Script" panel + Discord↔Roblox link store + profile API.
// One Node app on Render. Secrets come from env vars (set in the Render dashboard), never hard-coded.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
} = require("discord.js");
const GAMES = require("./games");

const {
  DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  PORT = 10000,
} = process.env;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); // this service's own https url
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || (PUBLIC_URL + "/auth/callback");
const HUB_LOADER = process.env.HUB_LOADER || "https://eccohub.xyz/loader.lua";
const LOGO = "https://eccohub.xyz/ecco_symbol.png";
const EMBED = 0x0b0b0b; // near-black; Discord treats 0x000000 as "no colour"

// ---------------------------------------------------------------- Supabase link store (ecc00_links)
// One row per Discord user: { token, discord_id, username, avatar }. Token is the handle the Lua script
// trades for the profile. See schema.sql.
const sbHeaders = () => ({
  "Content-Type": "application/json",
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
});
const sbReady = () => Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

async function getLinkByDiscord(discordId) {
  if (!sbReady()) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ecc00_links?discord_id=eq.${discordId}&select=*`, { headers: sbHeaders() });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
async function getLinkByToken(token) {
  if (!sbReady()) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ecc00_links?token=eq.${encodeURIComponent(token)}&select=*`, { headers: sbHeaders() });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
// Mint once per Discord user, reuse the same token on later links so their saved loadstring keeps working.
async function upsertLink(discordId, username, avatar) {
  if (!sbReady()) return null;
  const existing = await getLinkByDiscord(discordId);
  const token = existing ? existing.token : crypto.randomBytes(16).toString("hex");
  await fetch(`${SUPABASE_URL}/rest/v1/ecc00_links?on_conflict=discord_id`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ token, discord_id: String(discordId), username, avatar }),
  });
  return token;
}

function avatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  const i = (BigInt(user.id) >> 22n) % 6n; // new default-avatar formula
  return `https://cdn.discordapp.com/embed/avatars/${i}.png`;
}
function loadstringFor(token) {
  return `loadstring(game:HttpGet("${PUBLIC_URL}/s/${token}"))()`;
}

// ---------------------------------------------------------------- web
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true, bot: client?.isReady?.() || false }));

// Get Script → Discord OAuth (identify only)
app.get("/auth", (_req, res) => {
  const u = new URL("https://discord.com/api/oauth2/authorize");
  u.searchParams.set("client_id", DISCORD_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "identify");
  res.redirect(u.toString());
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect("/");
  try {
    const tok = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      }),
    }).then((r) => r.json());
    if (!tok.access_token) throw new Error("no access_token");
    const me = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());
    const name = me.global_name || me.username;
    const token = await upsertLink(me.id, name, avatarUrl(me));
    if (!token) throw new Error("link store unavailable");
    res.send(resultPage(name, avatarUrl(me), loadstringFor(token)));
  } catch (e) {
    res.status(500).send(resultPage("Error", LOGO, "-- linking failed: " + e.message));
  }
});

// Personalized loader: the hub loader with the viewer's token baked in, so the script shows their Discord.
app.get("/s/:token", async (req, res) => {
  const link = await getLinkByToken(req.params.token);
  res.type("text/plain");
  if (!link) return res.send('-- invalid or expired link; get a fresh one at the ECC00 panel');
  let loader;
  try { loader = await fetch(HUB_LOADER, { headers: { "User-Agent": "Roblox/WinInet" } }).then((r) => r.text()); }
  catch { return res.send("-- hub loader unreachable"); }
  res.send(`getgenv().ECC00_TOKEN=${JSON.stringify(link.token)};getgenv().ECC00_API=${JSON.stringify(PUBLIC_URL)}\n${loader}`);
});

// What the Lua script calls to fill the profile frame.
app.get("/api/profile", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const link = req.query.token && await getLinkByToken(req.query.token);
  if (!link) return res.status(404).json({ error: "no link" });
  res.json({ id: link.discord_id, username: link.username, avatar: link.avatar });
});

// ---------------------------------------------------------------- discord bot
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function panelMessage() {
  const rows = [];
  let row = new ActionRowBuilder();
  for (const g of GAMES) {
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(new ButtonBuilder()
      .setCustomId(`game:${g.key}`)
      .setLabel(g.soon ? `${g.name} (soon)` : g.name)
      .setEmoji(g.emoji)
      .setStyle(g.soon ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(Boolean(g.soon)));
  }
  if (row.components.length) rows.push(row);
  const embed = new EmbedBuilder()
    .setColor(EMBED)
    .setAuthor({ name: "ECC00", iconURL: LOGO })
    .setTitle("Free Scripts")
    .setThumbnail(LOGO)
    .setDescription("Pick a game. The bot DMs you a loadstring linked to your Discord — your name and avatar then show in the menu.")
    .setFooter({ text: "eccohub.xyz", iconURL: LOGO });
  return { embeds: [embed], components: rows };
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: [
      new SlashCommandBuilder().setName("panel").setDescription("Post the free-scripts panel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
      new SlashCommandBuilder().setName("getscript").setDescription("DM yourself your personalized loadstring").toJSON(),
    ],
  });
}

client.once(Events.ClientReady, async () => {
  console.log(`[+] ECC00 bot online as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error("command register:", e.message); }
});

async function dmLoadstring(interaction, game) {
  const u = interaction.user;
  const token = await upsertLink(u.id, u.global_name || u.username, avatarUrl(u));
  if (!token) return interaction.reply({ content: "Link store is offline, try again later.", ephemeral: true });
  const where = game ? `\nJoin **${game.name}** and run it:` : "\nRun it in any supported game:";
  const dm = new EmbedBuilder().setColor(EMBED).setAuthor({ name: "ECC00", iconURL: LOGO })
    .setTitle(game ? game.name : "Your loadstring")
    .setDescription(`${where}\n\`\`\`lua\n${loadstringFor(token)}\n\`\`\`\nIt carries your Discord profile into the menu.`)
    .setFooter({ text: "eccohub.xyz", iconURL: LOGO });
  try {
    await u.send({ embeds: [dm] });
    await interaction.reply({ content: "📬 Sent to your DMs.", ephemeral: true });
  } catch {
    await interaction.reply({ embeds: [dm], ephemeral: true }); // DMs closed → show ephemerally instead
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        await interaction.channel.send(panelMessage());
        return interaction.reply({ content: "Panel posted.", ephemeral: true });
      }
      if (interaction.commandName === "getscript") return dmLoadstring(interaction, null);
    } else if (interaction.isButton() && interaction.customId.startsWith("game:")) {
      const game = GAMES.find((g) => g.key === interaction.customId.slice(5));
      if (!game || game.soon) return interaction.reply({ content: "That one isn't out yet.", ephemeral: true });
      return dmLoadstring(interaction, game);
    }
  } catch (e) {
    console.error("interaction:", e.message);
    if (interaction.isRepliable() && !interaction.replied) interaction.reply({ content: "Something broke, try again.", ephemeral: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------- result page
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function resultPage(name, avatar, loadstring) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECC00</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="card"><img class="logo" src="${LOGO}" alt=""><h1>Linked</h1>
<div class="who"><img src="${esc(avatar)}" alt=""><span>${esc(name)}</span></div>
<p>Copy this loadstring. Your Discord shows in the menu.</p>
<pre id="ls">${esc(loadstring)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('ls').textContent);this.textContent='Copied'">Copy</button>
<a class="back" href="/">Back</a></main></body></html>`;
}

app.listen(PORT, () => console.log(`[+] web on :${PORT}`));
if (DISCORD_BOT_TOKEN) client.login(DISCORD_BOT_TOKEN).catch((e) => console.error("login:", e.message));
else console.log("[!] no DISCORD_BOT_TOKEN — web only");
