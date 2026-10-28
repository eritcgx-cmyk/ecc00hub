// Bot settings that must survive deploys (Render's disk is wiped on every deploy): one JSON message in a private
// #ecc00-data channel the bot creates for itself.
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const data = { games: [], removed: [], freePremium: {}, versions: {}, logChannel: null };
let msg = null;

const render = () => "```json\n" + JSON.stringify(data) + "\n```";

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
  msg = recent.find((m) => m.author.id === client.user.id && m.content.startsWith("```json"));
  if (msg) Object.assign(data, JSON.parse(msg.content.slice(8, -4)));
  else msg = await ch.send(render());
}

async function save() {
  if (msg) await msg.edit(render());
}

module.exports = { data, load, save };
