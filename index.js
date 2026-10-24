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
const GAMES = require("./games");
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

// ---------------------------------------------------------------- shared bits
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const UNIVERSAL = `loadstring(game:HttpGet("${HUB_LOADER}"))()`;
const FREE = GAMES.filter((g) => !g.paid && !g.soon);
const PAID = GAMES.filter((g) => g.paid);
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
      .addFields({ name: "Loadstring", value: lua(UNIVERSAL) }, { name: "Games", value: list(FREE) })],
  };
}

function paidPanel() {
  return {
    embeds: [brand(new EmbedBuilder()).setTitle("ECC00 Premium").setThumbnail(LOGO)
      .setDescription("For whitelisted members. Your key is tied to your Discord account.")
      .addFields({ name: "Games", value: list(PAID) })],
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
  () => ({ name: `${GAMES.filter((g) => !g.soon).length} games`, type: ActivityType.Watching }),
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

const cmds = [
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
      .addChoices(...GAMES.map((g) => ({ name: g.name, value: g.key })), { name: "Loader", value: "loader" }))
    .addStringOption((o) => o.setName("changes").setDescription("Changes, separated by ; or \\n").setRequired(true))
    .addStringOption((o) => o.setName("type").setDescription("Update (default) or a new release")
      .addChoices({ name: "Update", value: "update" }, { name: "Release", value: "release" }))
    .addStringOption((o) => o.setName("version").setDescription("Version, e.g. v1.4"))
    .addChannelOption(chanOpt).addStringOption(pingOpt),
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
].map((c) => c.toJSON());

const PINGS = { everyone: "@everyone", here: "@here" };
async function post(i, embed) {
  const ch = i.options.getChannel("channel") || i.channel;
  const ping = PINGS[i.options.getString("ping")];
  await ch.send({ content: ping, embeds: [embed], allowedMentions: { parse: ping ? ["everyone"] : [] } });
  return reply(i, { content: `Posted in ${ch}.` });
}
const lines = (s) => s.split(/\\n|\n|;/).map((x) => x.trim()).filter(Boolean);

async function onCommand(i) {
  const o = i.options;
  switch (i.commandName) {
    case "panel":
      await i.channel.send(o.getString("type") === "paid" ? paidPanel() : freePanel());
      return reply(i, { content: "Panel posted." });

    case "games":
      return i.reply({ embeds: [brand(new EmbedBuilder()).setTitle("Supported Games").setThumbnail(LOGO)
        .addFields({ name: "Paid", value: list(PAID) }, { name: "Free", value: list(FREE) })] });

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
      const game = GAMES.find((g) => g.key === key);
      const name = game ? game.name : "Loader";
      const v = o.getString("version");
      const verb = o.getString("type") === "release" ? "released" : "updated";
      const e = brand(new EmbedBuilder()).setTitle(`${name} ${verb}${v ? ` ${v}` : ""}`)
        .setDescription(lines(o.getString("changes")).map((c) => `- ${c}`).join("\n"))
        .setThumbnail(LOGO).setTimestamp();
      if (!game?.paid) e.addFields({ name: "Loadstring", value: lua(UNIVERSAL) }); // paid users get theirs from the panel
      return post(i, e);
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
        await ch.setTopic((ch.topic || "").replace(/weao:\S+(\s+version-\S+)?/i, "").trim());
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

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton() && i.customId.startsWith("paid:")) return await paidButton(i, i.customId.slice(5));
  } catch (e) {
    console.error("interaction:", e.message);
    if (i.isRepliable()) reply(i, { content: "Something broke: " + e.message }).catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`[+] ECC00 bot online as ${client.user.tag}`);
  try { await new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: cmds }); }
  catch (e) { console.error("command register:", e.message); }
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
