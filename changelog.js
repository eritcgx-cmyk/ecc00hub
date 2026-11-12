// Cloud data for the in-game UI: per-game changelogs (every /update post) and cloud notifications (/notify).
// Too big for the 2000-char store message, so it lives as a JSON file attached to its own message in #ecc00-data.
const { AttachmentBuilder } = require("discord.js");

const MARK = "ECC00 changelog storage (don't delete)";
const KEEP = 30; // changelog entries per game
const NOTICES = "__notices"; // reserved key: cloud notifications, newest first
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

const save = () => msg && msg.edit({ content: MARK, attachments: [], files: [new AttachmentBuilder(Buffer.from(JSON.stringify(logs)), { name: "changelog.json" })] });

async function add(game, entry) {
  logs[game] = [entry, ...(logs[game] || [])].slice(0, KEEP);
  await save();
}

// Plain text only: no Roblox rich-text tags, no control characters, 200 chars max. game = null means every game.
async function notify(text, game) {
  const clean = String(text || "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  if (!clean) throw new Error("empty notification");
  const n = { id: Date.now(), text: clean, game: game || null, at: new Date().toISOString() };
  logs[NOTICES] = [n, ...(logs[NOTICES] || [])].slice(0, 20);
  await save();
  return n;
}

const get = (game) => (game === NOTICES ? [] : logs[game] || []);
const notices = (game) => (logs[NOTICES] || []).filter((n) => !n.game || n.game === game).slice(0, 10);

module.exports = { load, add, get, notify, notices };
