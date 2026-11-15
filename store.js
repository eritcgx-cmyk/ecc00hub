// Bot settings that must survive deploys (Render's disk is wiped on every deploy): one JSON message in a private
// #ecc00-data channel the bot creates for itself.
const { ChannelType, PermissionFlagsBits, AttachmentBuilder } = require("discord.js");

const data = { games: [], removed: [], freePremium: {}, freeFeatures: {}, versions: {}, logChannel: null, gamesBoard: null };
let msg = null;

const FILE = "data.json";
const render = () => "```json\n" + JSON.stringify(data) + "\n```";
// a message holds 2000 chars; past that the JSON rides along as an attachment (editing would throw and take the bot down)
function payload() {
  const text = render();
  if (text.length <= 2000) return { content: text, files: [], attachments: [] };
  return { content: "ECC00 bot storage (attached). Don't delete.", files: [new AttachmentBuilder(Buffer.from(JSON.stringify(data)), { name: FILE })], attachments: [] };
}
const isStore = (m, botId) => m.author.id === botId && (m.content.startsWith("```json") || m.attachments.some((a) => a.name === FILE));
async function read(m) {
  const a = m.attachments.find((x) => x.name === FILE);
  return a ? JSON.parse(await (await fetch(a.url)).text()) : JSON.parse(m.content.slice(8, -4));
}

async function load(client) {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  let ch = guild.channels.cache.find((c) => c.name === "ecc00-data" && c.type === ChannelType.GuildText);
  if (!ch) {
    ch = await guild.channels.create({
      name: "ecc00-data", type: ChannelType.GuildText, topic: "ECC00 bot storage. Don't delete.",
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
  }
  const recent = await ch.messages.fetch({ limit: 20 });
  msg = recent.find((m) => isStore(m, client.user.id));
  if (msg) Object.assign(data, await read(msg));
  else msg = await ch.send(payload());
}

async function save() {
  if (msg) await msg.edit(payload());
}

module.exports = { data, load, save, _test: { payload, read, isStore } };
