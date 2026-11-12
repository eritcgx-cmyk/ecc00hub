// Per-game changelogs for the in-game Info tab: every /update post is saved here too. They outgrow the
// 2000-char store message, so they live as a JSON file attached to their own message in #ecc00-data.
const { AttachmentBuilder } = require("discord.js");

const MARK = "ECC00 changelog storage (don't delete)";
const KEEP = 30; // entries per game
let msg = null;
let logs = {}; // update key (ftf, mm2, sols...) -> [{ v, type, date, added, improved, fixed, removed }], newest first

async function load(client) {
  const guild = client.guilds.cache.first();
  const ch = guild && guild.channels.cache.find((c) => c.name === "ecc00-data");
  if (!ch) return;
  const recent = await ch.messages.fetch({ limit: 20 });
  msg = recent.find((m) => m.author.id === client.user.id && m.content === MARK) || (await ch.send(MARK));
  const file = msg.attachments.first();
  if (file) logs = await fetch(file.url).then((r) => r.json()).catch(() => ({}));
}

async function add(game, entry) {
  logs[game] = [entry, ...(logs[game] || [])].slice(0, KEEP);
  if (msg) await msg.edit({ content: MARK, attachments: [], files: [new AttachmentBuilder(Buffer.from(JSON.stringify(logs)), { name: "changelog.json" })] });
}

const get = (game) => logs[game] || [];

module.exports = { load, add, get };
