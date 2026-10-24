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
const { ActivityType, ChannelType } = require("discord.js");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const UNIVERSAL = `loadstring(game:HttpGet("${HUB_LOADER}"))()`;
const FREE = GAMES.filter((g) => !g.paid);
const PAID = GAMES.filter((g) => g.paid);
const brand = (e) => e.setColor(EMBED).setAuthor({ name: "ECC00", iconURL: LOGO }).setFooter({ text: "eccohub.xyz", iconURL: LOGO });

function buttonRows(games, prefix) {
  const rows = [];
  let row = new ActionRowBuilder();
  for (const g of games) {
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(new ButtonBuilder()
      .setCustomId(`${prefix}:${g.key}`)
      .setLabel(g.soon ? `${g.name} (soon)` : g.name)
      .setEmoji(g.emoji)
      .setStyle(g.soon ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(Boolean(g.soon)));
  }
  if (row.components.length) rows.push(row);
  return rows;
}

function panelMessage() {
  const embed = brand(new EmbedBuilder())
    .setTitle("Free Scripts")
    .setThumbnail(LOGO)
    .setDescription("Pick a game to get the loadstring.\nOne loadstring works for every game — it loads the right script automatically.\n\n"
      + `**Paid** (${PAID.map((g) => g.name).join(", ")}) need a key — ask staff.`);
  return { embeds: [embed], components: buttonRows(FREE, "game") };
}

function gamesEmbed() {
  const line = (g) => `${g.emoji} **${g.name}**${g.soon ? " — *soon*" : ""}`;
  return brand(new EmbedBuilder())
    .setTitle("Supported Games")
    .setThumbnail(LOGO)
    .addFields(
      { name: "💎 Paid (key)", value: PAID.map(line).join("\n") || "—" },
      { name: "🆓 Free", value: FREE.map(line).join("\n") || "—" },
      { name: "Loadstring", value: "```lua\n" + UNIVERSAL + "\n```" },
    );
}

// ---- status: set with /status, otherwise rotates through a few defaults.
let fixedStatus = null;
const ACT = { playing: ActivityType.Playing, watching: ActivityType.Watching, listening: ActivityType.Listening, competing: ActivityType.Competing };
const ROTATE = [
  () => ({ name: `${GAMES.filter((g) => !g.soon).length} games`, type: ActivityType.Watching }),
  () => ({ name: "eccohub.xyz", type: ActivityType.Playing }),
  () => ({ name: "/games", type: ActivityType.Listening }),
];
let rotI = 0;
function applyStatus() {
  if (!client.isReady()) return;
  const a = fixedStatus || ROTATE[rotI++ % ROTATE.length]();
  client.user.setPresence({ activities: [a], status: a.presence || "online" });
}

const staff = PermissionFlagsBits.ManageGuild;
const cmds = [
  new SlashCommandBuilder().setName("panel").setDescription("Post the free-scripts panel").setDefaultMemberPermissions(staff),
  new SlashCommandBuilder().setName("games").setDescription("Show every supported game, free and paid"),
  new SlashCommandBuilder().setName("getscript").setDescription("Get the ECC00 loadstring"),
  new SlashCommandBuilder().setName("announce").setDescription("Post an announcement").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("title").setDescription("Title").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Message (use \\n for new lines)").setRequired(true))
    .addChannelOption((o) => o.setName("channel").setDescription("Where to post (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName("ping").setDescription("Who to ping").addChoices(
      { name: "none", value: "none" }, { name: "@everyone", value: "everyone" }, { name: "@here", value: "here" }))
    .addAttachmentOption((o) => o.setName("image").setDescription("Image")),
  new SlashCommandBuilder().setName("update").setDescription("Post a script update log").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("game").setDescription("Game").setRequired(true)
      .addChoices(...GAMES.map((g) => ({ name: g.name, value: g.key }))))
    .addStringOption((o) => o.setName("changes").setDescription("Changes, separated by ; or \\n").setRequired(true))
    .addStringOption((o) => o.setName("version").setDescription("Version, e.g. v1.4"))
    .addChannelOption((o) => o.setName("channel").setDescription("Where to post (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName("ping").setDescription("Who to ping").addChoices(
      { name: "none", value: "none" }, { name: "@everyone", value: "everyone" }, { name: "@here", value: "here" })),
  new SlashCommandBuilder().setName("status").setDescription("Change the bot's status").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("type").setDescription("Activity").setRequired(true).addChoices(
      { name: "Playing", value: "playing" }, { name: "Watching", value: "watching" },
      { name: "Listening to", value: "listening" }, { name: "Competing in", value: "competing" },
      { name: "Reset (rotate defaults)", value: "reset" }))
    .addStringOption((o) => o.setName("text").setDescription("Status text"))
    .addStringOption((o) => o.setName("presence").setDescription("Dot colour").addChoices(
      { name: "Online", value: "online" }, { name: "Idle", value: "idle" }, { name: "Do not disturb", value: "dnd" })),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`[+] ECC00 bot online as ${client.user.tag}`);
  try { await new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: cmds }); }
  catch (e) { console.error("command register:", e.message); }
  applyStatus();
  setInterval(applyStatus, 60_000);
});

const PINGS = { everyone: "@everyone", here: "@here" };
async function post(interaction, embed) {
  const ch = interaction.options.getChannel("channel") || interaction.channel;
  const ping = PINGS[interaction.options.getString("ping")];
  await ch.send({ content: ping, embeds: [embed], allowedMentions: { parse: ping ? ["everyone"] : [] } });
  return interaction.reply({ content: `Posted in ${ch}.`, ephemeral: true });
}
const lines = (s) => s.split(/\\n|\n|;/).map((x) => x.trim()).filter(Boolean);

async function sendLoadstring(interaction, game) {
  // Personal loadstring (shows their Discord in the menu) when the link store is configured, else the universal one.
  const u = interaction.user;
  const token = await upsertLink(u.id, u.global_name || u.username, avatarUrl(u)).catch(() => null);
  const ls = token ? loadstringFor(token) : UNIVERSAL;
  const e = brand(new EmbedBuilder()).setTitle(game ? `${game.emoji} ${game.name}` : "Your loadstring")
    .setDescription(`${game ? `Join **${game.name}** and run:` : "Run in any supported game:"}\n\`\`\`lua\n${ls}\n\`\`\``);
  return interaction.reply({ embeds: [e], ephemeral: true });
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const o = interaction.options;
      switch (interaction.commandName) {
        case "panel":
          await interaction.channel.send(panelMessage());
          return interaction.reply({ content: "Panel posted.", ephemeral: true });
        case "games": return interaction.reply({ embeds: [gamesEmbed()] });
        case "getscript": return sendLoadstring(interaction, null);
        case "announce": {
          const e = brand(new EmbedBuilder()).setTitle(o.getString("title"))
            .setDescription(lines(o.getString("message")).join("\n")).setTimestamp();
          const img = o.getAttachment("image");
          if (img) e.setImage(img.url);
          return post(interaction, e);
        }
        case "update": {
          const g = GAMES.find((x) => x.key === o.getString("game"));
          const v = o.getString("version");
          const e = brand(new EmbedBuilder()).setTitle(`${g.emoji} ${g.name} updated${v ? ` — ${v}` : ""}`)
            .setDescription(lines(o.getString("changes")).map((c) => `• ${c}`).join("\n"))
            .addFields({ name: "Loadstring", value: "```lua\n" + UNIVERSAL + "\n```" })
            .setThumbnail(LOGO).setTimestamp();
          return post(interaction, e);
        }
        case "status": {
          const type = o.getString("type");
          if (type === "reset") fixedStatus = null;
          else {
            const text = o.getString("text");
            if (!text) return interaction.reply({ content: "Give it some text.", ephemeral: true });
            fixedStatus = { name: text, type: ACT[type], presence: o.getString("presence") || "online" };
          }
          applyStatus();
          return interaction.reply({ content: fixedStatus ? `Status set: ${type} ${fixedStatus.name}` : "Status reset to rotation.", ephemeral: true });
        }
      }
    } else if (interaction.isButton() && interaction.customId.startsWith("game:")) {
      const game = GAMES.find((g) => g.key === interaction.customId.slice(5));
      if (!game || game.soon) return interaction.reply({ content: "That one isn't out yet.", ephemeral: true });
      return sendLoadstring(interaction, game);
    }
  } catch (e) {
    console.error("interaction:", e.message);
    if (interaction.isRepliable() && !interaction.replied) interaction.reply({ content: "Something broke: " + e.message, ephemeral: true }).catch(() => {});
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
