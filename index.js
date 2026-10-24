// ECC00 hub service: the Discord bot, plus a tiny web root so Render has something to health-check.
// Identity comes from JNKIE (keys are tied to the buyer's Discord account), so there is no OAuth here.
const express = require("express");
const path = require("path");
const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
} = require("discord.js");
const GAMES = require("./games");

const {
  DISCORD_BOT_TOKEN,
  PORT = 10000,
} = process.env;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); // this service's own https url
const HUB_LOADER = process.env.HUB_LOADER || "https://eccohub.xyz/loader.lua";
const LOGO = "https://eccohub.xyz/ecco_symbol.png";
const EMBED = 0x0b0b0b; // near-black; Discord treats 0x000000 as "no colour"

// ---------------------------------------------------------------- web
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, bot: client?.isReady?.() || false }));

// ---------------------------------------------------------------- discord bot
const { ActivityType, ChannelType } = require("discord.js");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const UNIVERSAL = `loadstring(game:HttpGet("${HUB_LOADER}"))()`;
const FREE = GAMES.filter((g) => !g.paid);
const PAID = GAMES.filter((g) => g.paid);
const brand = (e) => e.setColor(EMBED).setAuthor({ name: "ECC00", iconURL: LOGO }).setFooter({ text: "eccohub.xyz", iconURL: LOGO });

function avatarUrl(u) {
  return u.displayAvatarURL ? u.displayAvatarURL({ extension: "png", size: 128 }) : LOGO;
}

// Two buttons, nothing else. Free hands over the loadstring; Paid is the Discord-linked side, so it
// shows who you are and that your key rides on this account.
function panelMessage() {
  const embed = brand(new EmbedBuilder())
    .setTitle("ECC00")
    .setThumbnail(LOGO)
    .setDescription("**Free** - no account needed.\n**Paid** - linked to your Discord.");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("get:free").setLabel("Free").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("get:paid").setLabel("Paid").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

function freeReply() {
  return brand(new EmbedBuilder()).setTitle("Free")
    .setDescription("```lua\n" + UNIVERSAL + "\n```\n" + FREE.filter((g) => !g.soon).map((g) => g.name).join(" | "));
}

function paidReply(user) {
  return brand(new EmbedBuilder()).setTitle("Paid")
    .setThumbnail(avatarUrl(user))
    .setDescription("**" + (user.globalName || user.username) + "**\nYour key is tied to this account, so the menu shows your name and avatar in game.")
    .addFields(
      { name: "Games", value: PAID.map((g) => "- " + g.name).join("\n") },
      { name: "Loadstring", value: "```lua\n" + UNIVERSAL + "\n```" },
    );
}

function gamesEmbed() {
  const line = (g) => `- ${g.name}${g.soon ? " (soon)" : ""}`;
  return brand(new EmbedBuilder())
    .setTitle("Supported Games")
    .setThumbnail(LOGO)
    .addFields(
      { name: "Paid (key)", value: PAID.map(line).join("\n") || "-" },
      { name: "Free", value: FREE.map(line).join("\n") || "-" },
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
  new SlashCommandBuilder().setName("update").setDescription("Post an update or release log").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("game").setDescription("Game, or the loader itself").setRequired(true)
      .addChoices(...GAMES.map((g) => ({ name: g.name, value: g.key })), { name: "Loader", value: "loader" }))
    .addStringOption((o) => o.setName("type").setDescription("Update (default) or a new release")
      .addChoices({ name: "Update", value: "update" }, { name: "Release", value: "release" }))
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

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const o = interaction.options;
      switch (interaction.commandName) {
        case "panel":
          await interaction.channel.send(panelMessage());
          return interaction.reply({ content: "Panel posted.", ephemeral: true });
        case "games": return interaction.reply({ embeds: [gamesEmbed()] });
        case "getscript": return interaction.reply({ embeds: [freeReply()], ephemeral: true });
        case "announce": {
          const e = brand(new EmbedBuilder()).setTitle(o.getString("title"))
            .setDescription(lines(o.getString("message")).join("\n")).setTimestamp();
          const img = o.getAttachment("image");
          if (img) e.setImage(img.url);
          return post(interaction, e);
        }
        case "update": {
          const key = o.getString("game");
          const name = key === "loader" ? "Loader" : GAMES.find((x) => x.key === key).name;
          const v = o.getString("version");
          const released = o.getString("type") === "release";
          const e = brand(new EmbedBuilder()).setTitle(`${name} ${released ? "released" : "updated"}${v ? ` ${v}` : ""}`)
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
    } else if (interaction.isButton() && interaction.customId.startsWith("get:")) {
      const paid = interaction.customId === "get:paid";
      return interaction.reply({ embeds: [paid ? paidReply(interaction.user) : freeReply()], ephemeral: true });
    }
  } catch (e) {
    console.error("interaction:", e.message);
    if (interaction.isRepliable() && !interaction.replied) interaction.reply({ content: "Something broke: " + e.message, ephemeral: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`[+] web on :${PORT}`));
if (DISCORD_BOT_TOKEN) client.login(DISCORD_BOT_TOKEN).catch((e) => console.error("login:", e.message));
else console.log("[!] no DISCORD_BOT_TOKEN — web only");
