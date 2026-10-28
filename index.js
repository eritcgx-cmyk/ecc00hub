// ECC00 hub service: the Discord bot, plus a tiny web root so Render has something to health-check.
// The whitelist is JNKIE (see jnkie.js): a paid user is a Discord account with an active premium key.
// Status channels are driven by WEAO (see tracker.js).
const express = require("express");
const path = require("path");
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
} = require("discord.js");
const BASE_GAMES = require("./games");
const store = require("./store");
const allGames = () => [...BASE_GAMES.filter((g) => !store.data.removed.includes(g.key)), ...store.data.games];
const jnkie = require("./jnkie");
const tracker = require("./tracker");

const { DISCORD_BOT_TOKEN, PORT = 10000 } = process.env;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); // this service's own https url
const HUB_LOADER = process.env.HUB_LOADER || "https://eccohub.xyz/loader.lua";
const LOGO = "https://eccohub.xyz/ecco_symbol.png";
const EMBED = 0x0b0b0b; // near-black; Discord treats 0x000000 as "no colour"

// ---------------------------------------------------------------- web
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, bot: client?.isReady?.() || false, jnkie: jnkie.ready() }));
// The in-game UI asks this for the profile frame: tier (the badge), Discord name and avatar. JNKIE only hands
// the script a Discord *ID* for keys made with /whitelist, so the bot resolves the name/avatar itself.
// Never returns the key, and only returns a profile for someone with an active key.
// ponytail: 60s in-memory cache per user; plenty for one lookup per script launch.
const tierCache = new Map();
app.get("/api/tier/:discordId", async (req, res) => {
  const id = req.params.discordId;
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: "bad id" });
  const hit = tierCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return res.json(hit.body);
  try {
    const key = await jnkie.keyFor(id);
    const body = { active: jnkie.active(key), tier: key ? jnkie.tierOf(key) : null };
    if (body.active) {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) Object.assign(body, { username: user.globalName || user.username, avatar: avatar(user) });
    }
    tierCache.set(id, { at: Date.now(), body });
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// Free scripts (MM2...) ask this with the key the user ran them with, to unlock premium options and show the
// Discord profile on that key. Answers only for a valid key, and never echoes the key back.
const keyCache = new Map();
app.get("/api/key/:key", async (req, res) => {
  const value = req.params.key;
  if (!/^[\w-]{8,100}$/.test(value)) return res.status(400).json({ error: "bad key" });
  const hit = keyCache.get(value);
  if (hit && Date.now() - hit.at < 60_000) return res.json(hit.body);
  try {
    const key = await jnkie.keyByValue(value);
    const body = { active: jnkie.active(key), tier: key ? jnkie.tierOf(key) : null };
    if (body.active && key.discord_id) {
      body.discordId = key.discord_id;
      const user = await client.users.fetch(key.discord_id).catch(() => null);
      if (user) Object.assign(body, { username: user.globalName || user.username, avatar: avatar(user) });
    }
    keyCache.set(value, { at: Date.now(), body });
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// Free (universal loader) scripts ask this on load: has staff made this script's premium features free?
app.get("/api/free/:script", (req, res) => res.json({ free: Boolean(store.data.freePremium[req.params.script]) }));
// The loader reports each launch here; it lands in the channel set with /logs. Anyone can call this, so it is
// size-capped and rate-limited (one log per Roblox user per 30s, 30 a minute overall) and never pings anyone.
const lastExec = new Map();
let execWindow = { start: 0, count: 0 };
app.post("/api/exec", express.json({ limit: "2kb" }), async (req, res) => {
  res.json({ ok: true });
  const b = req.body || {};
  const userId = Number(b.userId) || 0;
  const now = Date.now();
  if (!store.data.logChannel || !userId || now - (lastExec.get(userId) || 0) < 30_000) return;
  if (now - execWindow.start > 60_000) execWindow = { start: now, count: 0 };
  if (++execWindow.count > 30) return;
  lastExec.set(userId, now);
  const s = (v, n = 60) => String(v ?? "?").replace(/[`@]/g, "").slice(0, n) || "?";
  const place = Number(b.place) || 0;
  const ch = client.channels.cache.get(store.data.logChannel);
  if (!ch) return;
  ch.send({ content: store.data.logPing || undefined, allowedMentions: { parse: ["users", "roles"] }, embeds: [brand(new EmbedBuilder()).setTitle("Script Executed").setTimestamp().addFields(
    { name: "Script", value: s(b.script), inline: true },
    { name: "Executor", value: s(b.executor), inline: true },
    { name: "Key", value: b.keyed ? "Yes" : "No", inline: true },
    { name: "Game", value: place ? `[${s(b.game, 80)}](https://www.roblox.com/games/${place})` : s(b.game, 80) },
    { name: "User", value: `[${s(b.user, 40)}](https://www.roblox.com/users/${userId}/profile)` },
  )] }).catch(() => {});
});
app.get("/health/jnkie", (_req, res) => jnkie.ping()
  .then((services) => res.json({ ok: true, services }))
  .catch((e) => res.status(502).json({ ok: false, error: e.message })));

// ---------------------------------------------------------------- shared bits
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const UNIVERSAL = `loadstring(game:HttpGet("${HUB_LOADER}"))()`;
const freeGames = () => allGames().filter((g) => !g.paid && !g.soon);
const paidGames = () => allGames().filter((g) => g.paid);
const TIERS = ["user", "premium", "dev", "staff", "owner"];
const brand = (e) => e.setColor(EMBED).setAuthor({ name: "ECC00", iconURL: LOGO }).setFooter({ text: "eccohub.xyz", iconURL: LOGO });
const avatar = (u) => u.displayAvatarURL({ extension: "png", size: 128 });
const lua = (s) => "```lua\n" + s + "\n```";
const list = (games) => games.map((g) => "- " + g.name).join("\n") || "-";
const when = (iso) => (iso ? `<t:${Math.floor(new Date(iso) / 1000)}:R>` : "Never");
const reply = (i, body) => (i.deferred || i.replied ? i.editReply(body) : i.reply({ ...body, ephemeral: true }));

// "7d", "12h", "30m", "lifetime" -> minutes (null = forever)
function parseDuration(s) {
  if (!s || /^(life|perm|forever|lifetime)/i.test(s)) return null;
  const m = /^(\d+)\s*([mhdwy])/i.exec(s.trim());
  if (!m) throw new Error(`Can't read duration "${s}". Use 30m, 12h, 7d, 4w, 1y or lifetime.`);
  return Number(m[1]) * { m: 1, h: 60, d: 1440, w: 10080, y: 525600 }[m[2].toLowerCase()];
}

// ---------------------------------------------------------------- panels
function freePanel() {
  return {
    embeds: [brand(new EmbedBuilder()).setTitle("ECC00 Free").setThumbnail(LOGO)
      .setDescription("Paste this into your executor. It picks the right script for the game you're in.")
      .addFields({ name: "Loadstring", value: lua(UNIVERSAL) })],
  };
}

function paidPanel() {
  return {
    embeds: [brand(new EmbedBuilder()).setTitle("ECC00 Private").setThumbnail(LOGO)
      .setDescription("For whitelisted members. Your key is tied to your Discord account.")],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("paid:script").setLabel("Get Script").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("paid:hwid").setLabel("Reset HWID").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("paid:info").setLabel("Get Info").setStyle(ButtonStyle.Secondary),
    )],
  };
}

function infoEmbed(user, key) {
  const ok = jnkie.active(key);
  return brand(new EmbedBuilder()).setTitle(user.globalName || user.username).setThumbnail(avatar(user))
    .addFields(
      { name: "Status", value: !key ? "Not whitelisted" : key.is_invalidated ? "Revoked" : jnkie.expired(key) ? "Expired" : "Active", inline: true },
      { name: "Tier", value: key ? jnkie.tierOf(key) : "-", inline: true },
      { name: "Expires", value: key && ok ? when(key.expires_at) : "-", inline: true },
      { name: "HWIDs", value: key ? String(jnkie.hwidsOf(key).length) : "-", inline: true },
      { name: "Created", value: key ? when(key.created_at) : "-", inline: true },
    );
}

// Reset HWID is self-service, so it gets a cooldown.
// ponytail: in-memory, so a redeploy clears it; move to JNKIE key metadata if people abuse that.
const HWID_COOLDOWN = 24 * 60 * 60_000;
const lastReset = new Map();

async function paidButton(i, action) {
  await i.deferReply({ ephemeral: true });
  const key = await jnkie.keyFor(i.user.id);
  if (action === "info") return i.editReply({ embeds: [infoEmbed(i.user, key)] });
  if (!jnkie.active(key)) {
    return i.editReply({ embeds: [brand(new EmbedBuilder()).setTitle("Not whitelisted")
      .setDescription("This is for premium members only. Buy access or ask staff.")] });
  }
  if (action === "script") {
    return i.editReply({ embeds: [brand(new EmbedBuilder()).setTitle("Your script").setThumbnail(avatar(i.user))
      .setDescription("Keep this private. It's locked to your account and device.")
      .addFields({ name: "Loadstring", value: lua(`getgenv().SCRIPT_KEY = "${key.key_value}"\n${UNIVERSAL}`) })] });
  }
  // action === "hwid"
  const wait = (lastReset.get(i.user.id) || 0) + HWID_COOLDOWN - Date.now();
  if (wait > 0) return i.editReply({ content: `You can reset again ${when(new Date(Date.now() + wait).toISOString())}.` });
  await jnkie.resetHwid(key);
  lastReset.set(i.user.id, Date.now());
  return i.editReply({ content: "HWID reset. Run the script on your new device." });
}

// Give the member a server role named after their tier, if one exists. Best effort.
async function syncRole(guild, userId, tier) {
  try {
    const member = await guild.members.fetch(userId);
    const tierRoles = guild.roles.cache.filter((r) => TIERS.includes(r.name.toLowerCase()));
    const want = tierRoles.find((r) => r.name.toLowerCase() === tier);
    await member.roles.remove(tierRoles.filter((r) => r !== want && member.roles.cache.has(r.id)));
    if (want) await member.roles.add(want);
  } catch (e) { console.error("role sync:", e.message); }
}

// ---------------------------------------------------------------- presence
let fixedStatus = null;
const ACT = { playing: ActivityType.Playing, watching: ActivityType.Watching, listening: ActivityType.Listening, competing: ActivityType.Competing };
const ROTATE = [
  () => ({ name: `${allGames().filter((g) => !g.soon).length} games`, type: ActivityType.Watching }),
  () => ({ name: "eccohub.xyz", type: ActivityType.Playing }),
  () => ({ name: tracker.latest.roblox ? `Roblox ${tracker.latest.roblox.replace("version-", "").slice(0, 8)}` : "Roblox updates", type: ActivityType.Watching }),
];
let rot = 0;
function applyStatus() {
  if (!client.isReady()) return;
  const a = fixedStatus || ROTATE[rot++ % ROTATE.length]();
  client.user.setPresence({ activities: [{ name: a.name, type: a.type }], status: a.presence || "online" });
}

// ---------------------------------------------------------------- commands
const staff = PermissionFlagsBits.ManageGuild;
const pingOpt = (o) => o.setName("ping").setDescription("Who to ping").addChoices(
  { name: "none", value: "none" }, { name: "@everyone", value: "everyone" }, { name: "@here", value: "here" });
const chanOpt = (o) => o.setName("channel").setDescription("Where to post (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

const gameChoices = () => allGames().slice(0, 22).map((g) => ({ name: g.name, value: g.key })); // Discord caps choices at 25
const buildCmds = () => [
  new SlashCommandBuilder().setName("panel").setDescription("Post a panel").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("type").setDescription("Which panel").setRequired(true)
      .addChoices({ name: "Free", value: "free" }, { name: "Paid", value: "paid" })),
  new SlashCommandBuilder().setName("games").setDescription("Show every supported game"),
  new SlashCommandBuilder().setName("whitelist").setDescription("Manage premium access (JNKIE)").setDefaultMemberPermissions(staff)
    .addSubcommand((s) => s.setName("add").setDescription("Whitelist or renew a user")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addStringOption((o) => o.setName("tier").setDescription("Tier").setRequired(true).addChoices(...TIERS.map((t) => ({ name: t, value: t }))))
      .addStringOption((o) => o.setName("duration").setDescription("30m, 12h, 7d, 4w, 1y or lifetime (default lifetime)")))
    .addSubcommand((s) => s.setName("remove").setDescription("Revoke a user's access")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("info").setDescription("Look up a user's access")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("resethwid").setDescription("Reset a user's HWID (no cooldown)")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))),
  new SlashCommandBuilder().setName("blacklist").setDescription("Ban a user's key and devices (JNKIE)").setDefaultMemberPermissions(staff)
    .addSubcommand((s) => s.setName("add").setDescription("Revoke their key and ban every HWID it used")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Why")))
    .addSubcommand((s) => s.setName("remove").setDescription("Unban their HWIDs (does not re-whitelist)")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))),
  new SlashCommandBuilder().setName("announce").setDescription("Post an announcement").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("title").setDescription("Title").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Message (use \\n for new lines)").setRequired(true))
    .addChannelOption(chanOpt).addStringOption(pingOpt)
    .addAttachmentOption((o) => o.setName("image").setDescription("Image")),
  new SlashCommandBuilder().setName("update").setDescription("Post an update or release log").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("game").setDescription("Game, or the loader itself").setRequired(true)
      .addChoices(...gameChoices(), { name: "ECC00 Private", value: "private" }, { name: "Loader", value: "loader" }))
    .addStringOption((o) => o.setName("version").setDescription("New version, e.g. 2.6.0").setRequired(true))
    .addStringOption((o) => o.setName("type").setDescription("Update (default) or a new release")
      .addChoices({ name: "Update", value: "update" }, { name: "Release", value: "release" }))
    .addStringOption((o) => o.setName("added").setDescription("[+] Added, separated by ; or \\n"))
    .addStringOption((o) => o.setName("improved").setDescription("[*] Improved, separated by ; or \\n"))
    .addStringOption((o) => o.setName("fixed").setDescription("[!] Fixed, separated by ; or \\n"))
    .addStringOption((o) => o.setName("removed").setDescription("[-] Removed, separated by ; or \\n"))
    .addStringOption((o) => o.setName("private").setDescription("ECC00 Private-only additions, separated by ; or \\n"))
    .addChannelOption(chanOpt).addStringOption(pingOpt),
  new SlashCommandBuilder().setName("embed").setDescription("Build and post a custom embed").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("description").setDescription("Text (use \\n for new lines)").setRequired(true))
    .addStringOption((o) => o.setName("title").setDescription("Title"))
    .addStringOption((o) => o.setName("color").setDescription("Hex colour, e.g. #ff2d55"))
    .addAttachmentOption((o) => o.setName("image").setDescription("Big image"))
    .addAttachmentOption((o) => o.setName("thumbnail").setDescription("Small corner image"))
    .addStringOption((o) => o.setName("footer").setDescription("Footer text"))
    .addChannelOption(chanOpt).addStringOption(pingOpt),
  new SlashCommandBuilder().setName("ticket").setDescription("Post the support ticket panel").setDefaultMemberPermissions(staff)
    .addChannelOption(chanOpt),
  new SlashCommandBuilder().setName("logs").setDescription("Set where script execution logs go").setDefaultMemberPermissions(staff)
    .addChannelOption((o) => o.setName("channel").setDescription("Log channel (leave empty to turn logs off)").addChannelTypes(ChannelType.GuildText))
    .addMentionableOption((o) => o.setName("ping").setDescription("Who gets pinged on each execution (you, or a role)")),
  new SlashCommandBuilder().setName("tracker").setDescription("Status channels").setDefaultMemberPermissions(staff)
    .addSubcommand((s) => s.setName("link").setDescription("Auto-update a channel from WhatExpsAre.Online")
      .addChannelOption((o) => o.setName("channel").setDescription("Status channel").setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName("source").setDescription("Executor name (e.g. Volt), roblox, or ecc00").setRequired(true)))
    .addSubcommand((s) => s.setName("unlink").setDescription("Stop auto-updating a channel")
      .addChannelOption((o) => o.setName("channel").setDescription("Status channel").setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName("set").setDescription("Set a channel's dot by hand")
      .addChannelOption((o) => o.setName("channel").setDescription("Status channel").setRequired(true))
      .addStringOption((o) => o.setName("state").setDescription("New state").setRequired(true).addChoices(
        { name: "Up (green)", value: "up" }, { name: "Issues (yellow)", value: "issues" }, { name: "Down (red)", value: "down" }))),
  new SlashCommandBuilder().setName("status").setDescription("Change the bot's status").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("type").setDescription("Activity").setRequired(true).addChoices(
      { name: "Playing", value: "playing" }, { name: "Watching", value: "watching" },
      { name: "Listening to", value: "listening" }, { name: "Competing in", value: "competing" },
      { name: "Reset (rotate defaults)", value: "reset" }))
    .addStringOption((o) => o.setName("text").setDescription("Status text"))
    .addStringOption((o) => o.setName("presence").setDescription("Dot colour").addChoices(
      { name: "Online", value: "online" }, { name: "Idle", value: "idle" }, { name: "Do not disturb", value: "dnd" })),
  new SlashCommandBuilder().setName("addgame").setDescription("Add a game to the games list and /update").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("name").setDescription("Game name as players know it").setRequired(true))
    .addStringOption((o) => o.setName("type").setDescription("Free (universal loader) or paid (key)").setRequired(true)
      .addChoices({ name: "Free", value: "free" }, { name: "Paid", value: "paid" })),
  new SlashCommandBuilder().setName("removegame").setDescription("Remove a game from the games list").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("game").setDescription("Game").setRequired(true).addChoices(...gameChoices())),
  new SlashCommandBuilder().setName("freepremium").setDescription("Unlock a free script's premium features for everyone").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("script").setDescription("Universal-loader script (JNKIE scripts aren't affected)").setRequired(true)
      .addChoices(...freeGames().slice(0, 25).map((g) => ({ name: g.name, value: g.key }))))
    .addStringOption((o) => o.setName("state").setDescription("On = premium free for everyone").setRequired(true)
      .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })),
].map((c) => c.toJSON());

const PINGS = { everyone: "@everyone", here: "@here" };
async function post(i, embed) {
  const ch = i.options.getChannel("channel") || i.channel;
  const ping = PINGS[i.options.getString("ping")];
  await ch.send({ content: ping, embeds: [embed], allowedMentions: { parse: ping ? ["everyone"] : [] } });
  return reply(i, { content: `Posted in ${ch}.` });
}
const lines = (s) => s.split(/\\n|\n|;/).map((x) => x.trim()).filter(Boolean);

async function registerCommands() {
  try { await new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: buildCmds() }); }
  catch (e) { console.error("command register:", e.message); }
}
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "game";

async function onCommand(i) {
  const o = i.options;
  switch (i.commandName) {
    case "addgame": {
      const name = o.getString("name").trim();
      const key = slug(name);
      if (allGames().some((g) => g.key === key)) return reply(i, { content: `**${name}** is already on the list.` });
      await i.deferReply({ ephemeral: true });
      store.data.removed = store.data.removed.filter((k) => k !== key); // re-adding a removed built-in brings it back
      if (!BASE_GAMES.some((g) => g.key === key)) store.data.games.push({ key, name, paid: o.getString("type") === "paid" });
      await store.save();
      await registerCommands();
      return i.editReply(`Added **${name}** (${o.getString("type")}). It's in /games and /update now.`);
    }
    case "removegame": {
      const key = o.getString("game");
      const game = allGames().find((g) => g.key === key);
      if (!game) return reply(i, { content: "That game isn't on the list." });
      await i.deferReply({ ephemeral: true });
      store.data.games = store.data.games.filter((g) => g.key !== key);
      if (BASE_GAMES.some((g) => g.key === key)) store.data.removed.push(key);
      await store.save();
      await registerCommands();
      return i.editReply(`Removed **${game.name}**.`);
    }
    case "freepremium": {
      const key = o.getString("script");
      const on = o.getString("state") === "on";
      if (on) store.data.freePremium[key] = true; else delete store.data.freePremium[key];
      await store.save();
      const game = allGames().find((g) => g.key === key);
      return reply(i, { content: `Premium in **${game ? game.name : key}** is now ${on ? "free for everyone" : "key-only again"}. Takes effect next time the script loads.` });
    }
    case "panel":
      await i.channel.send(o.getString("type") === "paid" ? paidPanel() : freePanel());
      return reply(i, { content: "Panel posted." });

    case "games":
      return i.reply({ embeds: [brand(new EmbedBuilder()).setTitle("Supported Games").setThumbnail(LOGO)
        .addFields({ name: "Paid", value: list(paidGames()) }, { name: "Free", value: list(freeGames()) })] });

    case "whitelist": {
      await i.deferReply({ ephemeral: true });
      const user = o.getUser("user");
      const sub = o.getSubcommand();
      if (sub === "add") {
        const tier = o.getString("tier");
        const key = await jnkie.whitelist(user.id, tier, parseDuration(o.getString("duration")));
        await syncRole(i.guild, user.id, tier);
        return i.editReply({ content: `${user} whitelisted as **${tier}**.`, embeds: [infoEmbed(user, key)] });
      }
      const key = await jnkie.keyFor(user.id);
      if (sub === "info") return i.editReply({ embeds: [infoEmbed(user, key)] });
      if (!key) return i.editReply({ content: `${user} has no key.` });
      if (sub === "remove") {
        await jnkie.unwhitelist(key);
        await syncRole(i.guild, user.id, null);
        return i.editReply({ content: `${user}'s access is revoked.` });
      }
      await jnkie.resetHwid(key); // resethwid
      lastReset.delete(user.id);
      return i.editReply({ content: `${user}'s HWID is reset.` });
    }

    case "blacklist": {
      await i.deferReply({ ephemeral: true });
      const user = o.getUser("user");
      const key = await jnkie.keyFor(user.id);
      if (!key) return i.editReply({ content: `${user} has no key, so there are no devices to ban.` });
      if (o.getSubcommand() === "add") {
        const n = await jnkie.blacklist(key, o.getString("reason"));
        await syncRole(i.guild, user.id, null);
        return i.editReply({ content: `${user} blacklisted: key revoked, ${n} HWID(s) banned.` });
      }
      const n = await jnkie.unblacklist(key);
      return i.editReply({ content: `${user}: ${n} HWID(s) unbanned. Use /whitelist add to give access back.` });
    }

    case "announce": {
      const e = brand(new EmbedBuilder()).setTitle(o.getString("title"))
        .setDescription(lines(o.getString("message")).join("\n")).setTimestamp();
      const img = o.getAttachment("image");
      if (img) e.setImage(img.url);
      return post(i, e);
    }

    case "update": {
      const key = o.getString("game");
      const game = allGames().find((g) => g.key === key);
      const name = game ? game.name : key === "private" ? "ECC00 Private" : "Loader";
      const v = o.getString("version").trim();
      const rowsOf = (opt, mark) => lines(o.getString(opt) || "").map((t) => [mark, t]);
      const rows = [...rowsOf("added", "+"), ...rowsOf("improved", "*"), ...rowsOf("fixed", "!"), ...rowsOf("removed", "-")];
      const priv = rowsOf("private", "+");
      if (!rows.length && !priv.length) return reply(i, { content: "Add at least one change (added, improved, fixed, removed or private)." });
      const e = tracker.releaseEmbed(brand, {
        title: `${name} ${o.getString("type") === "release" ? "Release" : "Update"}`,
        from: store.data.versions[key], to: v, rows, extra: [["ECC00 Private", priv]],
      }).setThumbnail(LOGO);
      store.data.versions[key] = v; // next /update for this game shows "this -> new"
      store.save().catch(() => {});
      return post(i, e);
    }

    case "embed": {
      const e = brand(new EmbedBuilder()).setDescription(lines(o.getString("description")).join("\n"));
      const hex = (o.getString("color") || "").replace("#", "");
      if (/^[0-9a-f]{6}$/i.test(hex)) e.setColor(parseInt(hex, 16));
      if (o.getString("title")) e.setTitle(o.getString("title"));
      if (o.getAttachment("image")) e.setImage(o.getAttachment("image").url);
      if (o.getAttachment("thumbnail")) e.setThumbnail(o.getAttachment("thumbnail").url);
      if (o.getString("footer")) e.setFooter({ text: o.getString("footer"), iconURL: LOGO });
      return post(i, e);
    }

    case "ticket": {
      const ch = o.getChannel("channel") || i.channel;
      await ch.send({
        embeds: [brand(new EmbedBuilder()).setTitle("Support").setThumbnail(LOGO)
          .setDescription("Need help with a script, your key or a purchase? Open a ticket and staff will reply in a private channel.")],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket:open").setLabel("Open Ticket").setStyle(ButtonStyle.Primary))],
      });
      return reply(i, { content: `Ticket panel posted in ${ch}.` });
    }

    case "logs": {
      const ch = o.getChannel("channel");
      const who = o.getMentionable("ping");
      store.data.logChannel = ch ? ch.id : null;
      store.data.logPing = who ? (who.permissions !== undefined && !who.user ? `<@&${who.id}>` : `<@${who.id}>`) : null;
      await store.save();
      return reply(i, { content: ch ? `Execution logs now go to ${ch}${store.data.logPing ? `, pinging ${store.data.logPing}` : ""}.` : "Execution logs turned off." });
    }

    case "tracker": {
      const sub = o.getSubcommand();
      const ch = o.getChannel("channel");
      if (sub === "set") {
        if (!tracker.ANY_DOT.test(ch.name)) return reply(i, { content: `${ch} has no dot in its name to change.` });
        await i.deferReply({ ephemeral: true });
        await tracker.setDot(ch, o.getString("state")); // 2 renames / 10 min: a slow reply is Discord's rate limit
        return i.editReply(`${ch} updated.`);
      }
      await i.deferReply({ ephemeral: true });
      if (sub === "unlink") {
        await ch.setTopic((ch.topic || "").replace(/weao:\S+(\s+\S+)?/i, "").trim());
        return i.editReply(`${ch} is no longer tracked.`);
      }
      const source = o.getString("source").trim();
      let tag = source.toLowerCase();
      if (!["roblox", "ecc00"].includes(tag)) {
        const ex = (await tracker.exploits()).find((e) => e.title.toLowerCase() === tag);
        if (!ex) return i.editReply(`WhatExpsAre.Online has no executor called "${source}".`);
        tag = ex.title;
        if (!tracker.ANY_DOT.test(ch.name)) return i.editReply(`Put a dot (green/red) in ${ch}'s name first, e.g. ╠➣〢🟢〢${ex.title}-Status.`);
      }
      await ch.setTopic(`weao:${tag}`);
      tracker.tick(client, brand).catch(() => {});
      return i.editReply(`${ch} now follows **${tag}**. Checked every 2 minutes.`);
    }

    case "status": {
      const type = o.getString("type");
      if (type === "reset") fixedStatus = null;
      else {
        const text = o.getString("text");
        if (!text) return reply(i, { content: "Give it some text." });
        fixedStatus = { name: text, type: ACT[type], presence: o.getString("presence") || "online" };
      }
      applyStatus();
      return reply(i, { content: fixedStatus ? `Status set: ${type} ${fixedStatus.name}` : "Status reset to rotation." });
    }
  }
}

// ---------------------------------------------------------------- tickets
// One private channel per member under a "Tickets" category. The member and every role that can manage the
// server see it; the channel topic remembers whose ticket it is, so nothing is stored.
async function ticketButton(i, action) {
  const guild = i.guild;
  if (action === "close") {
    if (!(i.channel.topic || "").startsWith("ticket:")) return reply(i, { content: "This isn't a ticket." });
    await i.reply({ content: "Closing in 5 seconds." });
    return setTimeout(() => i.channel.delete().catch(() => {}), 5000);
  }
  await i.deferReply({ ephemeral: true });
  const open = guild.channels.cache.find((c) => c.topic === `ticket:${i.user.id}`);
  if (open) return i.editReply(`You already have a ticket: ${open}`);
  let cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === "Tickets");
  if (!cat) {
    cat = await guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }] });
  }
  const see = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
  const staffRoles = guild.roles.cache.filter((r) => r.id !== guild.roles.everyone.id && r.permissions.has(PermissionFlagsBits.ManageGuild));
  const ch = await guild.channels.create({
    name: `ticket-${i.user.username}`.slice(0, 90), type: ChannelType.GuildText, parent: cat.id, topic: `ticket:${i.user.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: i.user.id, allow: see },
      { id: client.user.id, allow: [...see, PermissionFlagsBits.ManageChannels] },
      ...staffRoles.map((r) => ({ id: r.id, allow: see })),
    ],
  });
  await ch.send({
    content: `${i.user}`,
    embeds: [brand(new EmbedBuilder()).setTitle("Ticket opened")
      .setDescription("Tell us what you need and staff will be with you soon. Press Close when you're done.")],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket:close").setLabel("Close").setStyle(ButtonStyle.Danger))],
  });
  return i.editReply(`Ticket opened: ${ch}`);
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton() && i.customId.startsWith("paid:")) return await paidButton(i, i.customId.slice(5));
    if (i.isButton() && i.customId.startsWith("ticket:")) return await ticketButton(i, i.customId.slice(7));
  } catch (e) {
    console.error("interaction:", e.message);
    if (i.isRepliable()) reply(i, { content: "Something broke: " + e.message }).catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`[+] ECC00 bot online as ${client.user.tag}`);
  try { await store.load(client); } catch (e) { console.error("store load:", e.message); }
  await registerCommands();
  applyStatus();
  setInterval(applyStatus, 60_000);
  tracker.start(client, brand);
});

app.listen(PORT, () => console.log(`[+] web on :${PORT}`));

// Render's free tier sleeps a web service after ~15 idle minutes and takes the bot down with it, so the
// service pings itself to stay awake.
// ponytail: self-ping keeps it up 24/7 on the free plan; drop it if this ever moves to a paid plan.
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL + "/health").catch(() => {}), 10 * 60_000);
if (DISCORD_BOT_TOKEN) client.login(DISCORD_BOT_TOKEN).catch((e) => console.error("login:", e.message));
else console.log("[!] no DISCORD_BOT_TOKEN — web only");
