// MM2 skin library for the ECC00 spoofer. Weapon models are private, so the only way to know what a knife or gun
// looks like is to see someone holding it. Every ECC00 MM2 script reports the skins it sees here, and every script
// downloads the whole list, so a skin seen once by anyone works for everyone.
// Stored as one JSON attachment in the bot's private #ecc00-data channel (Render's disk is wiped on deploy).
// ponytail: first report wins, no voting; a bad report only mis-skins a client-side visual. Add 2-reporter
// confirmation if someone starts poisoning it.
const { AttachmentBuilder, ChannelType, Events } = require("discord.js");

const FILE = "mm2_skins.json";
const MAX_IDS = 4000;
const ASSET = /^(rbxassetid:\/\/\d{1,20}|https?:\/\/www\.roblox\.com\/asset\/\?id=\d{1,20})$/;

// one reported skin -> a clean entry, or null if anything is off
function clean(e) {
  if (!e || typeof e !== "object") return null;
  const m = String(e.m || "").trim(), t = String(e.t || "").trim();
  if (!ASSET.test(m) || (t && !ASSET.test(t))) return null;
  const out = { m, t };
  if (Array.isArray(e.s) && e.s.length === 3 && e.s.every((n) => typeof n === "number" && n > 0.01 && n < 50)) out.s = e.s;
  if (e.snd && typeof e.snd === "object") {
    const snd = {};
    for (const [k, v] of Object.entries(e.snd).slice(0, 8)) {
      if (/^[A-Za-z0-9_ ]{1,32}$/.test(k) && ASSET.test(String(v).trim())) snd[k] = String(v).trim();
    }
    if (Object.keys(snd).length) out.snd = snd;
  }
  if (e.dual === true) out.dual = true;
  return out;
}

module.exports = function (app, express, client) {
  let skins = {};
  let msg = null;
  let dirty = false;
  const lastPost = new Map(); // ip -> time

  async function channel() {
    const guild = client.guilds.cache.first();
    return guild && guild.channels.cache.find((c) => c.name === "ecc00-data" && c.type === ChannelType.GuildText);
  }
  async function load() {
    const ch = await channel();
    if (!ch) return;
    const recent = await ch.messages.fetch({ limit: 30 });
    msg = recent.find((m) => m.author.id === client.user.id && m.attachments.some((a) => a.name === FILE));
    if (!msg) return;
    const res = await fetch(msg.attachments.find((a) => a.name === FILE).url);
    if (res.ok) skins = await res.json();
  }
  async function save() {
    if (!dirty) return;
    dirty = false;
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(skins)), { name: FILE });
    if (msg) await msg.edit({ content: "MM2 skin library (ECC00 spoofer). Don't delete.", files: [file], attachments: [] });
    else {
      const ch = await channel();
      if (ch) msg = await ch.send({ content: "MM2 skin library (ECC00 spoofer). Don't delete.", files: [file] });
    }
  }
  client.once(Events.ClientReady, () => load().catch((e) => console.error("skins load:", e.message)));
  setInterval(() => save().catch((e) => console.error("skins save:", e.message)), 60_000);

  app.get("/api/mm2/skins", (_req, res) => {
    res.set("Cache-Control", "public, max-age=120");
    res.json(skins);
  });

  app.post("/api/mm2/skins", express.json({ limit: "32kb" }), (req, res) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (Date.now() - (lastPost.get(ip) || 0) < 15_000) return res.status(429).json({ ok: false });
    lastPost.set(ip, Date.now());
    let added = 0;
    for (const [id, e] of Object.entries(req.body || {}).slice(0, 40)) {
      if (!/^[A-Za-z0-9_]{1,48}$/.test(id) || skins[id] || Object.keys(skins).length >= MAX_IDS) continue;
      const c = clean(e);
      if (c) { skins[id] = c; added++; }
    }
    if (added) dirty = true;
    res.json({ ok: true, added });
  });
};
module.exports.clean = clean;
