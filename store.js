// Bot settings that must survive deploys (Render's disk is wiped on every deploy): one JSON message in a private
// #ecc00-data channel the bot creates for itself.
const { ChannelType, PermissionFlagsBits, AttachmentBuilder } = require("discord.js");

const data = { games: [], removed: [], freePremium: {}, freeFeatures: {}, versions: {}, logChannel: null, gamesBoard: null };
let msg = null;
// the home server is the one with #ecc00-data: if the bot is ever added to a second server, data still loads from here
const home = (client) => client.guilds?.cache.find((g) => g.channels.cache.some((c) => c.name === "ecc00-data")) || client.guilds?.cache.first();

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
  if (!a) return JSON.parse(m.content.slice(8, -4));
  const r = await fetch(a.url);
  if (!r.ok) throw new Error(`store attachment ${r.status}`);
  return JSON.parse(await r.text());
}
// newest-first store messages -> the fullest one that reads. Any unreadable one means "don't guess": throw,
// so msg stays null and save() refuses instead of overwriting real settings with defaults.
async function pick(msgs) {
  let best = null, size = -1;
  for (const m of msgs) {
    const d = await read(m); // throws on a bad read; the caller keeps the bot from saving
    const n = JSON.stringify(d).length;
    if (n > size) { best = { m, d }; size = n; }
  }
  return best;
}

async function load(client) {
  const guild = home(client);
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
  const found = [];
  for (let before; found.length < 50;) { // the whole channel, not just the last 20: an old copy may sit further back
    const page = await ch.messages.fetch({ limit: 100, before });
    if (!page.size) break;
    found.push(...page.filter((m) => isStore(m, client.user.id)).values());
    before = page.last().id;
  }
  const best = await pick(found);
  if (best) { Object.assign(data, best.d); msg = best.m; }
  else msg = await ch.send(payload());
  console.log(`[store] ${found.length} copies, using ${msg.id}`);
}

async function save() {
  if (!msg) throw new Error("settings didn't load, not saving (would wipe them)");
  await msg.edit(payload());
}

module.exports = { data, load, save, home, _test: { payload, read, isStore, pick } };
