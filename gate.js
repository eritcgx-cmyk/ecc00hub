// Launch gate for the ECC00 loader. Every launch asks POST /api/session; this decides whether that Roblox
// account on that device may run that game, and if so hands back a short-lived signed ticket. The website
// (eccohub.xyz/api/load) checks the ticket's signature with the same GATE_SECRET and only then sends the script.
//
// Key modes (per game, falling back to the loader-wide default; set from Discord or the PC terminal):
//   keyless  anyone
//   discord  the player's Roblox account + device must be linked to a Discord account in the server
//            (loader shows a per-player phrase, they type it in the verify channel)
//   keyed    a JNKIE key: free checkpoint keys or premium keys
// Paid games always need a premium key. Every key is locked to one device.
//
// State that must survive redeploys (Render wipes its disk) lives as one message per record in a private
// #ecc00-db channel: "link <robloxId> <discordId> <hwid>" and "bind <sha256(key)> <hwid>".
// ponytail: one Discord message per record, loaded into memory at startup; move to a real DB past ~50k records.
const crypto = require("crypto");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const store = require("./store");
const jnkie = require("./jnkie");

const SECRET = process.env.GATE_SECRET || "";
const TICKET_SECONDS = 120;
const PHRASE_MINUTES = 15;
const MODES = ["keyless", "discord", "keyed"];

const links = new Map(); // robloxId -> { discordId, hwid, msg }
const binds = new Map(); // sha256(key) -> { hwid, msg }
const pending = new Map(); // phrase -> { robloxId, hwid, exp }
let dbChannel = null;
let games = { byPlace: new Map(), byKey: new Map() };

const settings = () => {
  store.data.gate ||= { defaultMode: "discord", modes: {}, off: {}, maintenance: null, verifyChannel: null, freeKeyHours: 24 };
  return store.data.gate;
};

// ---------------------------------------------------------------- storage
async function load(client) {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  dbChannel = guild.channels.cache.find((c) => c.name === "ecc00-db" && c.type === ChannelType.GuildText);
  if (!dbChannel) {
    dbChannel = await guild.channels.create({
      name: "ecc00-db", type: ChannelType.GuildText, topic: "ECC00 loader links. Don't delete or post here.",
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
  }
  let before;
  for (;;) {
    const page = await dbChannel.messages.fetch({ limit: 100, before });
    if (!page.size) break;
    for (const m of page.values()) {
      const [kind, a, b, c] = m.content.split(" ");
      if (kind === "link" && !links.has(a)) links.set(a, { discordId: b, hwid: c, msg: m });
      else if (kind === "bind" && !binds.has(a)) binds.set(a, { hwid: b, msg: m });
    }
    before = page.last().id;
  }
  await refreshGames();
  setInterval(refreshGames, 10 * 60_000);
  console.log(`[gate] ${links.size} links, ${binds.size} key binds`);
}

async function refreshGames() {
  try {
    const list = await fetch("https://eccohub.xyz/games.json").then((r) => r.json());
    const byPlace = new Map(), byKey = new Map();
    for (const [key, g] of Object.entries(list)) {
      byKey.set(key, { key, ...g });
      for (const p of g.places || []) byPlace.set(String(p), { key, ...g });
    }
    games = { byPlace, byKey };
  } catch (e) { console.error("[gate] games:", e.message); }
}

async function saveLink(robloxId, discordId, hwid) {
  const old = links.get(robloxId);
  if (old?.msg) old.msg.delete().catch(() => {});
  const msg = await dbChannel.send(`link ${robloxId} ${discordId} ${hwid}`);
  links.set(robloxId, { discordId, hwid, msg });
}
function dropLinksOf(discordId) {
  let n = 0;
  for (const [robloxId, l] of links) {
    if (l.discordId !== discordId) continue;
    l.msg?.delete().catch(() => {});
    links.delete(robloxId);
    n++;
  }
  return n;
}

// first device to use a key owns it; anyone else is refused until staff/the owner resets it
async function bindKey(key, hwid) {
  const h = crypto.createHash("sha256").update(key).digest("hex");
  const b = binds.get(h);
  if (b) return b.hwid === hwid;
  const msg = await dbChannel.send(`bind ${h} ${hwid}`);
  binds.set(h, { hwid, msg });
  return true;
}
function resetBind(key) {
  const h = crypto.createHash("sha256").update(key).digest("hex");
  binds.get(h)?.msg?.delete().catch(() => {});
  return binds.delete(h);
}

// ---------------------------------------------------------------- tickets
const b64 = (s) => Buffer.from(s).toString("base64url");
function ticket(body) {
  const data = b64(JSON.stringify({ ...body, e: Math.floor(Date.now() / 1000) + TICKET_SECONDS, n: crypto.randomBytes(6).toString("hex") }));
  return data + "." + crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

// the same player on the same device always gets the same phrase, so a bot restart doesn't strand anyone
const WORDS = "amber blade cobra delta ember frost ghost hydra ion jade karma lunar mirage nova onyx pulse quartz raven storm titan ultra viper wolf xenon yeti zephyr".split(" ");
function phraseFor(robloxId, hwid) {
  const h = crypto.createHmac("sha256", SECRET).update(`${robloxId}:${hwid}`).digest();
  return `ecc00 ${WORDS[h[0] % WORDS.length]} ${WORDS[h[1] % WORDS.length]} ${h.readUInt16BE(2) % 900 + 100}`;
}

// No verify channel set yet: use one called "verify", or make it (everyone can type, the bot cleans up).
async function ensureVerifyChannel(client) {
  const guild = client.guilds?.cache.first();
  if (!guild) return;
  let ch = guild.channels.cache.find((c) => c.name === "verify" && c.type === ChannelType.GuildText);
  if (!ch) {
    ch = await guild.channels.create({
      name: "verify", type: ChannelType.GuildText, rateLimitPerUser: 5,
      topic: "Type the phrase the ECC00 loader shows you. Your message is deleted right after.",
    }).catch(() => null);
  }
  if (!ch) return;
  settings().verifyChannel = ch.id;
  await store.save().catch(() => {});
}

// ---------------------------------------------------------------- the launch check
const isId = (v) => /^\d{1,20}$/.test(String(v));
const isStr = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

async function profileOf(client, discordId) {
  const u = discordId && await client.users.fetch(discordId).catch(() => null);
  return u ? { id: discordId, username: u.globalName || u.username, avatar: u.displayAvatarURL({ extension: "png", size: 128 }) } : null;
}

async function session(client, b) {
  const s = settings();
  if (!SECRET) return { ok: false, reason: "Loader is not set up yet." };
  if (!s.verifyChannel) await ensureVerifyChannel(client);
  if (!isId(b.robloxId) || !isStr(b.hwid, 128) || !isId(b.placeId)) return { ok: false, reason: "Bad request." };
  if (s.maintenance) return { ok: false, reason: s.maintenance };
  const robloxId = String(b.robloxId), hwid = b.hwid;

  const UNIVERSAL = { key: "universal", name: "Universal", file: "universal.lua" };
  // the loader's game picker can ask for Universal instead of the detected game
  const game = b.want === "universal" ? UNIVERSAL : (games.byPlace.get(String(b.placeId)) || UNIVERSAL);
  if (s.off[game.key]) return { ok: false, reason: `${game.name} is turned off right now.` };
  const mode = game.paid ? "keyed" : (s.modes[game.key] || s.defaultMode || "discord");
  const about = { mode, game: game.key, name: game.name }; // every answer says which game, so the loader can show it

  // a key always counts, in any mode: it's how premium unlocks
  let tier = "free", profile = null, keyed = false;
  if (isStr(b.key, 128) && /^[\w-]{8,128}$/.test(b.key)) {
    const k = await jnkie.keyByValue(b.key).catch(() => null);
    if (!jnkie.active(k)) return { ok: false, need: "key", getKey: s.getKeyUrl || null, reason: "That key is invalid or expired.", ...about };
    if (!(await bindKey(b.key, hwid))) return { ok: false, need: "key", getKey: s.getKeyUrl || null, reason: "This key is locked to another device. Reset HWID in the Discord panel.", ...about };
    // free checkpoint keys aren't premium and only last s.freeKeyHours (set from the PC terminal)
    if (!k.is_premium && Date.parse(k.created_at) + (s.freeKeyHours || 24) * 3600_000 < Date.now()) {
      return { ok: false, need: "key", getKey: s.getKeyUrl || null, reason: "Your free key ran out. Get a new one.", ...about };
    }
    keyed = true;
    tier = k.is_premium ? jnkie.tierOf(k) : "free";
    profile = await profileOf(client, k.discord_id);
  }

  if (mode === "discord" && !keyed) {
    const link = links.get(robloxId);
    if (!link || link.hwid !== hwid) {
      const phrase = phraseFor(robloxId, hwid);
      pending.set(phrase, { robloxId, hwid, exp: Date.now() + PHRASE_MINUTES * 60_000 });
      const ch = s.verifyChannel && client.channels.cache.get(s.verifyChannel);
      return { ok: false, need: "discord", phrase, channel: ch ? `#${ch.name}` : "#verify", ...about };
    }
    profile = await profileOf(client, link.discordId);
  }
  if (mode === "keyed" && !keyed) return { ok: false, need: "key", getKey: s.getKeyUrl || null, reason: "This game needs a key.", ...about };
  const premium = tier !== "free" || Boolean(store.data.freePremium[game.key]);
  if (game.paid && !premium) return { ok: false, need: "key", getKey: s.getKeyUrl || null, reason: `${game.name} needs a premium key.`, ...about };

  return {
    ok: true, mode, tier, premium, profile, game: game.key, name: game.name,
    ticket: ticket({ g: game.key, f: game.file, p: premium ? 1 : 0, r: robloxId }),
  };
}

// ---------------------------------------------------------------- Discord side
// A message in the verify channel that matches someone's phrase links that Roblox account to its author.
async function onMessage(m) {
  const s = settings();
  if (m.author.bot || !s.verifyChannel || m.channelId !== s.verifyChannel) return;
  const phrase = m.content.trim().toLowerCase().replace(/\s+/g, " ");
  const p = pending.get(phrase);
  m.delete().catch(() => {}); // keep the channel clean: phrases are single-use anyway
  if (!p || p.exp < Date.now()) {
    const r = await m.channel.send(`${m.author}, that phrase isn't active. Copy it again from the loader.`).catch(() => null);
    return r && setTimeout(() => r.delete().catch(() => {}), 8000);
  }
  pending.delete(phrase);
  await saveLink(p.robloxId, m.author.id, p.hwid);
  const r = await m.channel.send(`${m.author}, you're linked. Go back to Roblox, the loader opens by itself.`).catch(() => null);
  if (r) setTimeout(() => r.delete().catch(() => {}), 8000);
}

const onLeave = (member) => { const n = dropLinksOf(member.id); if (n) console.log(`[gate] ${member.id} left, dropped ${n} links`); };

const gameList = () => [...games.byKey.values()];

// gate.test.js swaps in a fake db channel and game list
const _setForTest = (db, list) => { dbChannel = db; games = { byPlace: new Map(list.flatMap((g) => g.places.map((p) => [String(p), g]))), byKey: new Map(list.map((g) => [g.key, g])) }; };

module.exports = { _setForTest, load, session, onMessage, onLeave, settings, resetBind, dropLinksOf, refreshGames, gameList, links, MODES };
