// ECC00 hub service: the Discord bot, plus a tiny web root so Render has something to health-check.
// The whitelist is JNKIE (see jnkie.js): a paid user is a Discord account with an active premium key.
// Status channels are driven by WEAO (see tracker.js).
const express = require("express");
const path = require("path");
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActivityType, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, MediaGalleryBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const BASE_GAMES = require("./games");
const GAME_FEATURES = require("./features.json"); // rebuilt from the script sources (scratch features.mjs)
// Starter FAQ entries (/faq seed). Short Q + A about the key system and common issues.
const FAQ_SEED = [
  ["My key is invalid or expired", "Keys last 24 hours and lock to one device. Grab a fresh one with the Get Key button in the key channel (or eccohub.xyz/key), then paste it into the loader."],
  ["How do I get a key?", "Verify once by typing the phrase the loader shows you in the verify channel. Then press Get Key, finish the checkpoints, copy your key and paste it into the ECC00 loader."],
  ["Basic vs Basic+ vs ECC00 Private", "Basic (1 checkpoint): every free feature. Basic+ (2 checkpoints): Basic plus FTF Auto Farm. ECC00 Private (paid): everything, premium features included. See /features for any game."],
  ["This key is locked to another device", "Each key binds to the first device that runs it. Use Reset HWID in the key panel, then the same key works on your new device."],
  ["The script won't load / the loader does nothing", "Paste the whole loadstring and finish verify first. Sealed games load through our site, so give it a few seconds. Still stuck? Open a ticket."],
  ["Premium features are greyed out", "Those need an ECC00 Private key; a free or Basic+ key shows them locked. FTF Auto Farm needs Basic+."],
  ["Do I have to verify every time?", "No. Your device stays linked after the first verify. You only paste a new key when the old one expires (24h)."],
  ["Is it safe? Will I get banned?", "Use any executor script at your own risk. We never ask for your password and never store it. Don't share your key with anyone."],
];
const store = require("./store");
const isUi = (g) => /^(ecc00\s*)?ui$/i.test(g.name.trim()); // the UI gets /update posts but isn't a game
const allGames = () => [...BASE_GAMES.filter((g) => !store.data.removed.includes(g.key)), ...store.data.games].filter((g) => !isUi(g));
const jnkie = require("./jnkie");
const tracker = require("./tracker");
const gate = require("./gate");
const changelog = require("./changelog");
const lazy = require("./lazy");

const { DISCORD_BOT_TOKEN, PORT = 10000 } = process.env;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); // this service's own https url
const HUB_LOADER = process.env.HUB_LOADER || "https://eccohub.xyz/loader.lua";
const LOGO = "https://eccohub.xyz/ecco_symbol.png";
const EMBED = 0x0b0b0b; // near-black; Discord treats 0x000000 as "no colour"

// ---------------------------------------------------------------- web
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, bot: client?.isReady?.() || false, jnkie: jnkie.ready() }));
// Per-IP attempt limiter: true once this IP has used `max` tries within `ms`.
// ponytail: in-memory and cleared when it gets big; a restart resets it, fine for guess-limiting.
const buckets = new Map();
const ipOf = (req) => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip).split(",")[0]; // Cloudflare sets the first one itself; x-forwarded-for can be faked
function limited(req, name, max, ms) {
  const ip = ipOf(req);
  const k = name + ":" + ip, now = Date.now(), b = buckets.get(k);
  if (buckets.size > 50_000) buckets.clear();
  if (!b || now - b.start > ms) { buckets.set(k, { start: now, n: 1 }); return false; }
  return ++b.n > max;
}
// The in-game UI asks this for the profile frame: tier (the badge), Discord name and avatar.
// Only answers for the Roblox account (?r=) that just launched through the gate as this Discord user, so nobody
// can look up whether some other Discord user bought premium. Never returns the key.
// ponytail: 60s in-memory cache per user; plenty for one lookup per script launch.
const tierCache = new Map();
app.get("/api/tier/:discordId", async (req, res) => {
  const id = req.params.discordId;
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: "bad id" });
  if (limited(req, "tier", 30, 60_000)) return res.status(429).json({ error: "slow down" });
  if (gate.lastSeen.get(String(req.query.r || ""))?.discordId !== id) return res.status(403).json({ error: "launch through the loader first" });
  const hit = tierCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return res.json(hit.body);
  try {
    const key = await jnkie.keyFor(id);
    const body = { active: jnkie.active(key), tier: key ? (jnkie.isPaid(jnkie.planOf(key)) ? jnkie.planOf(key) : "user") : null };
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
// In-game Info tab: this game's latest update posts (newest first). Public, read-only.
app.get("/api/changelog/:game", (req, res) => res.json(changelog.get(String(req.params.game)).slice(0, 10)));
// In-game cloud notifications for this game (plus ones for every game). Read-only; the UI checks once a minute.
app.get("/api/notices/:game", (req, res) => {
  if (limited(req, "notices", 30, 60_000)) return res.status(429).json([]);
  res.json(changelog.notices(String(req.params.game)));
});
// Free (universal loader) scripts ask this on load: has staff made this script's premium features free?
app.get("/api/free/:script", (req, res) => res.json({
  free: Boolean(store.data.freePremium[req.params.script]),
  features: (store.data.freeFeatures || {})[req.params.script] || [],
}));

// premium features that can be made free on their own (/freefeature). Each one is its own module in the private
// Blob (premium/<game>_<feature>.lua), so making one free never hands out the rest of the premium code.
// While any of a game's features is free, /api/load sends that game's premium file to everyone and the script
// unlocks only the free features (the rest stay locked rows).
const FEATURES = [
  { value: "mm2:spoofer", name: "MM2 - Spoofer tab" },
  { value: "mm2:autothrow", name: "MM2 - Auto Throw Knife" },
];
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
  // Discord comes from the bot's own link table, not from what the loader claims
  // a premium key carries its owner's Discord too, so fall back to whoever their last allowed launch was
  const seen = gate.lastSeen.get(String(userId));
  const link = gate.links.get(String(userId)) || (seen?.discordId ? seen : null);
  const job = /^[\w-]{8,64}$/.test(String(b.jobId || "")) ? b.jobId : null;
  // Plan/Method come from the gate's own record of this launch (gate.lastSeen), never from what the loader
  // claims in the POST — so a spoofed /api/exec can't make the log say "ECC00 Private" it didn't earn.
  const plan = seen?.tester ? "Tester" : seen?.plan || (b.mode === "keyless" ? "Keyless" : "Free");
  const method = seen?.tester ? "Tester code"
    : seen?.premium ? "Premium key"
    : seen?.plan === "Basic+" ? "Basic+ key"
    : seen?.keyed ? "Basic key"
    : seen ? "Discord verify"
    : b.mode === "keyless" ? "Keyless"
    : s(b.mode, 20);
  ch.send({ content: store.data.logPing || undefined, allowedMentions: { parse: ["users", "roles"] }, embeds: [brand(new EmbedBuilder()).setTitle("Script Executed").setTimestamp().addFields(
    { name: "Script", value: s(b.script), inline: true },
    { name: "Plan", value: plan, inline: true },
    { name: "Method", value: method, inline: true },
    { name: "Executor", value: s(b.executor), inline: true },
    { name: "Platform", value: s(b.platform, 20), inline: true },
    { name: "Key used", value: seen?.keyed ? "Yes" : "No", inline: true },
    { name: "Roblox", value: `[${s(b.displayName, 40)} (@${s(b.user, 40)})](https://www.roblox.com/users/${userId}/profile)\nAccount age: ${Number(b.accountAge) || 0} days`, inline: true },
    { name: "Discord", value: link ? `<@${link.discordId}>` : "Not linked", inline: true },
    { name: "Game", value: (place ? `[${s(b.game, 80)}](https://www.roblox.com/games/${place})` : s(b.game, 80)) + (job ? `\nServer: \`${job}\`` : "") },
  )] }).catch(() => {});
});
// The loader asks this on every launch: may this Roblox account + device run this game? (see gate.js)
const lastSession = new Map();
app.post("/api/session", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = ipOf(req);
  // 10 asks per 10s per IP: a house or school shares one IP, and the loader polls while waiting for a phrase
  const now = Date.now();
  if (lastSession.size > 50_000) lastSession.clear();
  const w = lastSession.get(ip);
  if (!w || now - w.start > 10_000) lastSession.set(ip, { start: now, n: 1 });
  else if (++w.n > 10) return res.status(429).json({ ok: false, reason: "Slow down." });
  try { res.json(await gate.session(client, req.body || {})); }
  catch (e) { console.error("session:", e.message); res.status(500).json({ ok: false, reason: "Server error, try again." }); }
});
// The owner's PC terminal tool (ecc00.mjs) drives the loader setup through this. Same GATE_SECRET as the
// tickets, sent as a Bearer token; anyone without it gets 403.
app.post("/api/admin", express.json({ limit: "4kb" }), async (req, res) => {
  const secret = process.env.GATE_SECRET || "";
  const sent = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!secret || sent.length !== Buffer.byteLength(secret) || !require("crypto").timingSafeEqual(sent, Buffer.from(secret))) return res.status(403).json({ error: "forbidden" });
  const g = gate.settings();
  const { action, target, value } = req.body || {};
  if (action === "mode") {
    if (!gate.MODES.includes(value) && value !== "default") return res.status(400).json({ error: "mode must be keyless, discord, keyed or default" });
    if (target === "loader") { if (value !== "default") g.defaultMode = value; }
    else if (value === "default") delete g.modes[target];
    else g.modes[target] = value;
  } else if (action === "game") {
    if (value === "off") g.off[target] = true; else delete g.off[target];
  } else if (action === "maintenance") {
    g.maintenance = value || null;
  } else if (action === "keyhours") {
    const h = Number(value);
    if (!(h > 0 && h <= 8760)) return res.status(400).json({ error: "hours must be 1-8760" });
    g.freeKeyHours = h;
  } else if (action === "build") {
    if (value && !/^https:\/\/(vault\.pandauth\.com|api\.jnkie\.com)\/\S+$/.test(value)) return res.status(400).json({ error: "expected a vault.pandauth.com or api.jnkie.com link" });
    if (value) g.build[target] = value; else delete g.build[target];
  } else if (action === "seal") { // target: a game key or "all"; value on|off
    if (!/^\w{1,32}$/.test(target || "")) return res.status(400).json({ error: "seal <game|all> <on|off>" });
    g.sealed ||= {};
    if (value === "on") g.sealed[target] = true; else delete g.sealed[target];
  } else if (action === "getkey") {
    if (value && !/^https:\/\/\S+$/.test(value)) return res.status(400).json({ error: "link must start with https://" });
    g.getKeyUrl = value || null;
  } else if (action === "pluskey") { // the Basic+ JNKIE get-key link (2 checkpoints)
    if (value && !/^https:\/\/\S+$/.test(value)) return res.status(400).json({ error: "link must start with https://" });
    g.plusKeyUrl = value || null;
  } else if (action === "testbasicplus") { // mint a Basic+ test key (unlocks Auto Farm only)
    try { return res.json({ ok: true, key: await jnkie.basicPlusKey(Number(value) || 1440) }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  } else if (action === "tempkeys") { // read-only: premium keys with a length; never returns key values
    return res.json((await jnkie.tempKeys()).map((k) => ({ discordId: k.discord_id, plan: jnkie.planOf(k), created: k.created_at, ends: k.expires_at, minutes: k.validity_minutes, noEnd: k.noEnd })));
  } else if (action === "restore") { // value: { build: {game: url}, verifyChannel, versions: {game: v} } — refill lost settings
    const v = value || {};
    for (const [k, u] of Object.entries(v.build || {})) {
      if (!/^https:\/\/(vault\.pandauth\.com|api\.jnkie\.com)\/\S+$/.test(u)) return res.status(400).json({ error: `bad build link for ${k}` });
      g.build[k] = u;
    }
    if (v.verifyChannel) { if (!/^\d{17,20}$/.test(v.verifyChannel)) return res.status(400).json({ error: "bad channel id" }); g.verifyChannel = v.verifyChannel; }
    Object.assign(store.data.versions, v.versions || {});
    if (v.testerCode) { if (!/^[a-f0-9]{48}$/.test(v.testerCode)) return res.status(400).json({ error: "bad tester code" }); g.testerCode = v.testerCode; }
    const byName = (n) => { // "games" matches "╠➣〢🧩〢games"
      const plain = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
      return [...(store.home(client)?.channels.cache.values() || [])].find((c) => c.isTextBased() && plain(c.name) === plain(n));
    };
    if (v.logChannel) { const c = byName(v.logChannel); if (!c) return res.status(400).json({ error: "log channel not found" }); store.data.logChannel = c.id; }
    if (v.gamesBoard) {
      const c = byName(v.gamesBoard); if (!c) return res.status(400).json({ error: "games channel not found" });
      store.data.gamesBoard = { ...store.data.gamesBoard, channel: c.id, sig: null };
      await refreshBoard().catch(() => {});
    }
  } else if (action === "tester") { // a new code replaces the old one right away
    g.testerCode = value === "off" ? null : require("crypto").randomBytes(24).toString("hex");
  } else if (action === "notify") { // value: { text, game }
    const n = await changelog.notify((value || {}).text, (value || {}).game);
    return res.json({ ok: true, notice: n });
  } else if (action === "update" || action === "retract") {
    // update: { game, version, type, added, improved, fixed, removed, private, channel, ping }
    // retract: { game, channel, title, notice, minutes } - deletes the bot's posts titled `title` from the last
    // `minutes` and the in-game changelog/notices for `game` that start with `notice` (undo a wrong /update)
    const u = value || {};
    if (action === "update" && !u.game) return res.status(400).json({ error: "game is required" }); // no game = a 'Loader' post + a notice shown in every game
    const guild = store.home(client);
    const plain = (n) => String(n || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, ""); // "📢・updates" matches "updates"
    const want = plain(u.channel);
    const text = guild ? [...guild.channels.cache.values()].filter((c) => c.isTextBased() && !c.isThread?.()) : [];
    const ch = want && (text.find((c) => plain(c.name) === want) || text.find((c) => plain(c.name).includes(want)));
    if (!ch) return res.status(400).json({ error: "channel not found", channels: text.map((c) => c.name) });
    if (action === "retract") {
      const since = Date.now() - (Number(u.minutes) || 60) * 60000;
      const msgs = await ch.messages.fetch({ limit: 50 });
      const bad = msgs.filter((m) => m.author.id === client.user.id && m.createdTimestamp > since && m.embeds[0]?.title === u.title);
      for (const m of bad.values()) await m.delete();
      const dropped = await changelog.retract(String(u.game ?? ""), String(u.notice || ""));
      return res.json({ ok: true, deleted: bad.size, ...dropped });
    }
    const e = updateEmbed(String(u.game || ""), String(u.version || ""), u.type, (k) => u[k]);
    if (!e) return res.status(400).json({ error: "no changes" });
    const ping = PINGS[u.ping];
    await ch.send({ content: ping, embeds: [e], allowedMentions: { parse: ping ? ["everyone"] : [] } });
    return res.json({ ok: true, posted: `#${ch.name}` });
  } else if (action !== "show") {
    return res.status(400).json({ error: "unknown action" });
  }
  if (action !== "show") await store.save();
  res.json({ ...g, linked: gate.links.size, games: gate.gameList().map((x) => x.key),
    saved: { games: store.data.games.map((x) => x.name), removed: store.data.removed, versions: store.data.versions,
      freePremium: Object.keys(store.data.freePremium), logChannel: Boolean(store.data.logChannel) } });
});
app.get("/health/jnkie", (req, res) => limited(req, "jnkie", 5, 60_000) ? res.status(429).json({ ok: false }) : jnkie.ping()
  .then((services) => res.json({ ok: true, services }))
  .catch((e) => res.status(502).json({ ok: false, error: e.message })));

// ---------------------------------------------------------------- shared bits
// GuildMessages + MessageContent read phrases typed in the verify channel; GuildMembers sees people leave.
// MessageContent and GuildMembers are "privileged": they must be switched on in the Discord Developer Portal.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  rest: { rejectOnRateLimit: (d) => d.route.startsWith("/webhooks") && d.retryAfter > 10_000 } }); // fail loudly, never wait for hours
client.rest.on("rateLimited", (d) => console.error("rate limited:", d.method, d.route, d.retryAfter + "ms", d.scope, d.global ? "global" : ""));
const UNIVERSAL = `loadstring(game:HttpGet("${HUB_LOADER}"))()`;
const freeGames = () => allGames().filter((g) => !g.paid && !g.freemium && !g.soon);
const freemiumGames = () => allGames().filter((g) => g.freemium && !g.paid && !g.soon);
const paidGames = () => allGames().filter((g) => g.paid);
const TIERS = ["user", "premium", "dev", "staff", "owner"];
const brand = (e) => e.setColor(EMBED).setAuthor({ name: "ECC00", iconURL: LOGO }).setFooter({ text: "eccohub.xyz", iconURL: LOGO });
const avatar = (u) => u.displayAvatarURL({ extension: "png", size: 128 });
const lua = (s) => "```lua\n" + s + "\n```";
const column = (games) => games.map((g) => "\u25B8 " + g.name).join("\n") || "-";
const when = (iso) => (iso ? `<t:${Math.floor(new Date(iso) / 1000)}:R>` : "Never");
const reply = (i, body) => (i.deferred || i.replied ? i.editReply(body) : i.reply({ ...body, ephemeral: true }));

// "7d", "12h", "30m", "1 month", "lifetime" -> minutes (null = forever)
function parseDuration(s) {
  if (!s || /^(life|perm|forever|lifetime)/i.test(s)) return null;
  const m = /^(\d+)\s*(mo|[mhdwy])[a-z]*$/i.exec(s.trim());
  if (!m) throw new Error(`Can't read duration "${s}". Use 30m, 12h, 7d, 4w, 1mo, 1y or lifetime.`);
  return Number(m[1]) * { m: 1, h: 60, d: 1440, w: 10080, mo: 43200, y: 525600 }[m[2].toLowerCase()];
}

// ---------------------------------------------------------------- games list
function gamesEmbed() {
  const paid = paidGames(), mid = freemiumGames(), free = freeGames();
  return brand(new EmbedBuilder()).setTitle("Supported Games").setThumbnail(LOGO).addFields(
    { name: `ECC00 Private (${paid.length})`, value: column(paid), inline: true },
    { name: `Basic + Private (${mid.length})`, value: column(mid), inline: true },
    { name: `Basic (${free.length})`, value: column(free), inline: true })
    .setDescription("Plans: **Keyless**, **Basic** (1 checkpoint), **Basic+** (2 checkpoints, FTF Auto Farm), **ECC00 Private** (paid). `/features` lists every game's features by plan.");
}

// /features: pick a game, see what each plan gets
const PLAN_NOTE = { "Basic": "1 checkpoint key", "Basic+": "2 checkpoint key", "ECC00 Private": "paid" };
const featuresMenu = () => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("features")
  .setPlaceholder("Pick a game").addOptions(Object.entries(GAME_FEATURES).slice(0, 25).map(([k, g]) => ({ label: g.name, value: k }))));
function featuresEmbed(key) {
  const g = GAME_FEATURES[key];
  const e = brand(new EmbedBuilder()).setTitle(g ? `${g.name} features` : "Features by plan");
  if (!g) return e.setDescription("Plans: **Keyless**, **Basic** (1 checkpoint), **Basic+** (2 checkpoints, adds FTF Auto Farm), **ECC00 Private** (paid).\nPick a game below.");
  e.setDescription("Each plan also gets everything in the plans above it.");
  for (const [plan, list] of Object.entries(g.plans)) {
    let chunk = "", n = 0; // embed fields cap at 1024 chars
    for (const f of list) {
      if (chunk.length + f.length + 3 > 1000) { e.addFields({ name: n++ ? `${plan} (cont.)` : `${plan} (${PLAN_NOTE[plan]})`, value: chunk }); chunk = ""; }
      chunk += (chunk ? ", " : "") + f;
    }
    if (chunk) e.addFields({ name: n ? `${plan} (cont.)` : `${plan} (${PLAN_NOTE[plan]})`, value: chunk });
  }
  return e;
}

// The board deletes itself and reposts only when the list really changed, so restarts don't bump the channel.
async function refreshBoard() {
  const b = store.data.gamesBoard;
  if (!b?.channel) return;
  const sig = "tiers2" + JSON.stringify([paidGames(), freemiumGames(), freeGames()].map((l) => l.map((g) => g.name))); // bump the prefix when the layout changes
  if (b.sig === sig) return;
  const ch = await client.channels.fetch(b.channel).catch(() => null);
  if (!ch) return console.error("games board: channel is gone");
  if (b.message) await ch.messages.delete(b.message).catch(() => {});
  const msg = await ch.send({ embeds: [gamesEmbed()] });
  store.data.gamesBoard = { channel: b.channel, message: msg.id, sig };
  await store.save();
}

// ---------------------------------------------------------------- panels
const BANNER = path.join(__dirname, "public", "getkey.gif");
const PRICES = ["**Weekly** `2.50 USD` · `400 Robux`", "**Monthly** `6 USD` · `800 Robux`", "**Lifetime** `12 USD` · `1,500 Robux`"].join("\n");
const text = (t) => new TextDisplayBuilder().setContent(t);
const row = (...b) => new ActionRowBuilder().addComponents(...b);
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const link = (label, url) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);
const keyLinks = () => {
  const g = gate.settings(), free = g.getKeyUrl || "https://eccohub.xyz/key";
  return [link("Free key", free), link("Basic+ key", g.plusKeyUrl || free)];
};
const card = () => new ContainerBuilder().setAccentColor(0xffffff)
  .addMediaGalleryComponents(new MediaGalleryBuilder().addItems((m) => m.setURL("attachment://getkey.gif").setDescription("ECC00 Hub")));
const cardMsg = (c) => ({ flags: MessageFlags.IsComponentsV2, components: [c], files: [{ attachment: BANNER, name: "getkey.gif" }], allowedMentions: { parse: [] } });

function getKeyPanel() {
  return cardMsg(card()
    .addTextDisplayComponents(text(`## Premium\n${PRICES}\n\nEvery premium feature in every game.`))
    .addActionRowComponents(row(btn("ticket:buy", "Buy Premium", ButtonStyle.Primary)))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`### FREE ACCESS\n**Free** 1 checkpoint, all free features, ${gate.settings().freeKeyHours || 24} hours\n**Basic+** 2 checkpoints, adds FTF Auto Farm, ${gate.settings().freeKeyHours || 24} hours`))
    .addActionRowComponents(row(...keyLinks()))
    .addTextDisplayComponents(text("-# Verify first: type the phrase the loader shows you, then paste your key into the loader.")));
}

function controlPanel() {
  return cardMsg(card()
    .addTextDisplayComponents(text("## ECC00 Hub\nRedeem a key, grab your script and manage your device."))
    .addActionRowComponents(row(btn("paid:script", "Get Script", ButtonStyle.Primary), btn("paid:redeem", "Redeem Key"), btn("paid:hwid", "Reset HWID"), btn("paid:info", "My Info")))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`### LOADSTRING\n${lua(UNIVERSAL)}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text("### NEED A KEY?\nFree and Basic+ use checkpoints. Premium opens a ticket."))
    .addActionRowComponents(row(...keyLinks(), btn("ticket:buy", "Buy Premium"))));
}

const PLAN_NAME = { free: "Free", "basic+": "Basic+" };
const planName = (key) => { const p = jnkie.planOf(key); return PLAN_NAME[p] || p[0].toUpperCase() + p.slice(1); };
const { endsAt } = jnkie;
const full = (iso) => (iso ? `<t:${Math.floor(new Date(iso) / 1000)}:f>\n${when(iso)}` : "Never");

function infoEmbed(user, key) {
  const linked = [...gate.links].filter(([, l]) => l.discordId === user.id).map(([id]) => `[${id}](https://www.roblox.com/users/${id}/profile)`);
  const status = !key ? "No key" : key.is_invalidated ? "Revoked" : jnkie.expired(key) ? "Expired" : "Active";
  const ready = cooldownEnds(user.id);
  return brand(new EmbedBuilder()).setTitle(user.globalName || user.username).setThumbnail(avatar(user))
    .addFields(
      { name: "Plan", value: status === "Active" ? planName(key) : key ? `None (was ${planName(key)})` : "None", inline: true },
      { name: "Status", value: status, inline: true },
      { name: status === "Expired" ? "Expired" : "Expires", value: key && !key.is_invalidated ? full(endsAt(key)) : "-", inline: true },
      { name: "Device", value: !key ? "-" : jnkie.hwidsOf(key).length || gate.isBound(key.key_value) ? "Locked to one device" : "Not used yet", inline: true },
      { name: "HWID reset", value: ready ? when(ready) : "Ready", inline: true },
      { name: "Key made", value: key ? full(key.created_at) : "-", inline: true },
      { name: "Roblox", value: linked.slice(0, 10).join("\n") || "Not linked" },
    );
}

// Reset HWID is self-service, so it gets a cooldown (/hwidcooldown, minutes, default 1 day), kept in the store
// so a redeploy doesn't clear it.
const cooldownMs = () => (store.data.hwidCooldown ?? 1440) * 60_000;
function cooldownEnds(userId) {
  const t = ((store.data.hwidResets || {})[userId] || 0) + cooldownMs();
  return t > Date.now() ? new Date(t).toISOString() : null;
}
async function setReset(userId, at) {
  const r = (store.data.hwidResets ||= {});
  for (const [id, t] of Object.entries(r)) if (t + cooldownMs() < Date.now()) delete r[id]; // keeps the store small
  if (at) r[userId] = at; else delete r[userId];
  await store.save();
}
async function resetDevice(key) {
  await jnkie.resetHwid(key);
  gate.resetBind(key.key_value); // the loader's own device lock too
}

const redeemTries = new Map();
async function redeemModal(i) {
  const now = Date.now(), t = (redeemTries.get(i.user.id) || []).filter((x) => now - x < 10 * 60_000);
  if (t.length >= 5) return reply(i, { content: "Too many tries. Wait 10 minutes." });
  if (redeemTries.size > 10_000) redeemTries.clear();
  redeemTries.set(i.user.id, [...t, now]);
  await i.deferReply({ ephemeral: true });
  const value = i.fields.getTextInputValue("key").trim();
  if (!/^[\w-]{8,128}$/.test(value)) return i.editReply({ content: "That doesn't look like a key." });
  let key;
  try { key = await jnkie.redeem(i.user.id, value); } catch (e) { return i.editReply({ content: e.message }); }
  redeemTries.delete(i.user.id);
  const plan = jnkie.planOf(key);
  if (jnkie.isPaid(plan) && i.guild) await premiumRole(i.guild, i.user.id, true);
  return i.editReply({ content: `${planName(key)} redeemed. Press Get Script for your loadstring.`, embeds: [infoEmbed(i.user, key)] });
}

async function paidButton(i, action) {
  if (action === "redeem") {
    return i.showModal(new ModalBuilder().setCustomId("redeem").setTitle("Redeem Key").addComponents(row(
      new TextInputBuilder().setCustomId("key").setLabel("Your key").setStyle(TextInputStyle.Short).setMinLength(8).setMaxLength(128))));
  }
  await i.deferReply({ ephemeral: true });
  const key = await jnkie.keyFor(i.user.id);
  if (action === "info") return i.editReply({ embeds: [infoEmbed(i.user, key)] });
  const ok = jnkie.active(key);
  if (action === "script") {
    const script = ok ? `getgenv().SCRIPT_KEY = "${key.key_value}"\n${UNIVERSAL}` : UNIVERSAL;
    return i.editReply({ embeds: [brand(new EmbedBuilder()).setTitle("Your script").setThumbnail(avatar(i.user))
      .setDescription(ok ? `${planName(key)}. Keep this private, it's locked to your account and device.` : "You have no active key, so this is the plain loader. Get a key, then redeem it or paste it in.")
      .addFields({ name: "Loadstring", value: lua(script) })] });
  }
  // action === "hwid"
  if (!ok) return i.editReply({ content: "You have no active key. Redeem one first." });
  const wait = cooldownEnds(i.user.id);
  if (wait) return i.editReply({ content: `You can reset again ${when(wait)}.` });
  (store.data.hwidResets ||= {})[i.user.id] = Date.now(); // claimed now, so a double click can't reset twice
  try { await resetDevice(key); } catch (e) { delete store.data.hwidResets[i.user.id]; throw e; }
  await setReset(i.user.id, Date.now());
  return i.editReply({ content: "HWID reset. Run the script on your new device." });
}

// Add or take just the premium role: redeeming or lapsing must never touch dev/staff/owner.
async function premiumRole(guild, userId, on) {
  try {
    const role = guild.roles.cache.find((r) => r.name.toLowerCase() === "premium");
    if (!role) return;
    const member = await guild.members.fetch(userId);
    await (on ? member.roles.add(role) : member.roles.remove(role));
  } catch (e) { console.error("premium role:", e.message); }
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
const gateChoices = () => [{ name: "Loader (default)", value: "loader" }, { name: "Universal", value: "universal" },
  ...gate.gameList().slice(0, 23).map((g) => ({ name: g.name.slice(0, 100), value: g.key }))];
const buildCmds = () => [
  new SlashCommandBuilder().setName("panel").setDescription("Post a panel").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("type").setDescription("Which panel").setRequired(true)
      .addChoices({ name: "Control panel", value: "control" }, { name: "Get key", value: "getkey" })),
  new SlashCommandBuilder().setName("generatekey").setDescription("Make keys people redeem in the panel").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("plan").setDescription("Plan").setRequired(true)
      .addChoices({ name: "Free", value: "free" }, { name: "Basic+", value: "basic+" }, { name: "Premium", value: "premium" }))
    .addStringOption((o) => o.setName("duration").setDescription("Starts when redeemed: 3d, 1w, 1mo, 1y or lifetime").setRequired(true))
    .addIntegerOption((o) => o.setName("amount").setDescription("How many (default 1)").setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder().setName("hwidcooldown").setDescription("How often members can reset their HWID").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("duration").setDescription("e.g. 12h or 1d (default 1d)")),
  new SlashCommandBuilder().setName("tempkeys").setDescription("List premium users on a timed key").setDefaultMemberPermissions(staff)
    .addUserOption((o) => o.setName("revoke").setDescription("Revoke this user's timed premium")),
  new SlashCommandBuilder().setName("games").setDescription("Show every supported game"),
  new SlashCommandBuilder().setName("features").setDescription("Every game's features, by plan (Basic, Basic+, ECC00 Private)"),
  new SlashCommandBuilder().setName("gamesboard").setDescription("Post a games list that keeps itself up to date").setDefaultMemberPermissions(staff)
    .addChannelOption(chanOpt),
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
      .addChoices(...gameChoices(), { name: "ECC00 Private", value: "private" }, { name: "Loader", value: "loader" }, { name: "UI", value: "ui" }, { name: "Universal", value: "universal" }))
    .addStringOption((o) => o.setName("version").setDescription("New version, e.g. 2.6.0").setRequired(true))
    .addStringOption((o) => o.setName("type").setDescription("Update (default) or a new release")
      .addChoices({ name: "Update", value: "update" }, { name: "Release", value: "release" }))
    .addStringOption((o) => o.setName("added").setDescription("[+] Added, separated by ; or \\n"))
    .addStringOption((o) => o.setName("improved").setDescription("[*] Improved, separated by ; or \\n"))
    .addStringOption((o) => o.setName("fixed").setDescription("[!] Fixed, separated by ; or \\n"))
    .addStringOption((o) => o.setName("removed").setDescription("[-] Removed, separated by ; or \\n"))
    .addStringOption((o) => o.setName("private").setDescription("ECC00 Private-only additions, separated by ; or \\n"))
    .addChannelOption(chanOpt).addStringOption(pingOpt),
  new SlashCommandBuilder().setName("notify").setDescription("Send an in-game notification to everyone running ECC00").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("message").setDescription("Plain text, up to 200 characters").setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName("game").setDescription("Only players in this game (default: everyone)").addChoices(...gameChoices(), { name: "Universal", value: "universal" })),
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
  new SlashCommandBuilder().setName("faq").setDescription("Script & key-system FAQ").setDefaultMemberPermissions(staff)
    .addSubcommand((s) => s.setName("post").setDescription("Post the FAQ (one forum thread each, or one embed in a text channel)")
      .addChannelOption((o) => o.setName("channel").setDescription("Forum or text channel").setRequired(true).addChannelTypes(ChannelType.GuildForum, ChannelType.GuildText)))
    .addSubcommand((s) => s.setName("add").setDescription("Add a FAQ entry")
      .addStringOption((o) => o.setName("question").setDescription("Question").setRequired(true))
      .addStringOption((o) => o.setName("answer").setDescription("Answer").setRequired(true)))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a FAQ entry")
      .addStringOption((o) => o.setName("id").setDescription("Entry id (from /faq list)").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List FAQ entries and their ids"))
    .addSubcommand((s) => s.setName("seed").setDescription("Add the starter FAQ entries (key system + common issues)")),
  new SlashCommandBuilder().setName("gate").setDefaultMemberPermissions(staff).setDescription("Loader key system")
    .addSubcommand((s) => s.setName("mode").setDescription("Key mode for a game, or the loader default")
      .addStringOption((o) => o.setName("target").setDescription("Game, or Loader (default for every game)").setRequired(true).addChoices(...gateChoices()))
      .addStringOption((o) => o.setName("mode").setDescription("Mode").setRequired(true).addChoices(
        { name: "Keyless", value: "keyless" }, { name: "Discord", value: "discord" }, { name: "Keyed", value: "keyed" }, { name: "Discord + Key", value: "discordkey" }, { name: "Use loader default", value: "default" })))
    .addSubcommand((s) => s.setName("game").setDescription("Turn a game on or off")
      .addStringOption((o) => o.setName("target").setDescription("Game").setRequired(true).addChoices(...gateChoices().slice(1)))
      .addStringOption((o) => o.setName("state").setDescription("On or off").setRequired(true).addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })))
    .addSubcommand((s) => s.setName("maintenance").setDescription("Put the whole loader in maintenance")
      .addStringOption((o) => o.setName("message").setDescription("Shown in the loader. Leave empty to end maintenance.")))
    .addSubcommand((s) => s.setName("verify").setDescription("Channel where players type their phrase")
      .addChannelOption((o) => o.setName("channel").setDescription("Verify channel").setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName("unlink").setDescription("Remove someone's Discord link (they verify again)")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("show").setDescription("Show the current setup")),
  new SlashCommandBuilder().setName("logs").setDescription("Set where script execution logs go").setDefaultMemberPermissions(staff)
    .addChannelOption((o) => o.setName("channel").setDescription("Log channel (leave empty to turn logs off)").addChannelTypes(ChannelType.GuildText))
    .addMentionableOption((o) => o.setName("ping").setDescription("Who gets pinged on each execution (you, or a role)")),
  new SlashCommandBuilder().setName("tracker").setDescription("Status channels").setDefaultMemberPermissions(staff)
    .addSubcommand((s) => s.setName("link").setDescription("Auto-update a channel from WhatExpsAre.Online")
      .addChannelOption((o) => o.setName("channel").setDescription("Status channel").setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName("source").setDescription("Executor name (e.g. Volt), pc (every PC executor), roblox, or ecc00").setRequired(true)))
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
      .addChoices(...[...freemiumGames(), ...freeGames()].slice(0, 25).map((g) => ({ name: g.name, value: g.key }))))
    .addStringOption((o) => o.setName("state").setDescription("On = premium free for everyone").setRequired(true)
      .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })),
  ...(FEATURES.length ? [new SlashCommandBuilder().setName("freefeature").setDescription("Make one premium feature free for everyone (or key-only again)").setDefaultMemberPermissions(staff)
    .addStringOption((o) => o.setName("feature").setDescription("Feature").setRequired(true).addChoices(...FEATURES))
    .addStringOption((o) => o.setName("state").setDescription("On = free for everyone").setRequired(true)
      .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" }))] : []),
].map((c) => c.toJSON());

const PINGS = { everyone: "@everyone", here: "@here" };
// one /update post; get(k) reads the added/improved/fixed/removed/private text. Saves the version for "old -> new".
function updateEmbed(key, version, type, get) {
  const game = allGames().find((g) => g.key === key);
  const name = game ? game.name : { private: "ECC00 Private", ui: "UI", universal: "Universal" }[key] || "Loader";
  const v = String(version).trim();
  const rowsOf = (opt, mark) => lines(get(opt) || "").map((t) => [mark, t]);
  const rows = [...rowsOf("added", "+"), ...rowsOf("improved", "*"), ...rowsOf("fixed", "!"), ...rowsOf("removed", "-")];
  const priv = rowsOf("private", "+");
  if (!rows.length && !priv.length) return null;
  const e = tracker.releaseEmbed(brand, {
    title: `${name} ${type === "release" ? "Release" : "Update"}`,
    from: store.data.versions[key], to: v, rows, extra: [["ECC00 Private", priv]],
  }).setThumbnail(LOGO);
  store.data.versions[key] = v; // next /update for this game shows "this -> new"
  // the in-game Info tab shows this too (GET /api/changelog/<key>)
  changelog.add(key, { v, type: type === "release" ? "Release" : "Update", date: new Date().toISOString().slice(0, 10),
    added: lines(get("added") || ""), improved: lines(get("improved") || ""), fixed: lines(get("fixed") || ""), removed: lines(get("removed") || "") })
    .then(() => changelog.notify(`${name} v${v} is out. See the Changelog in the Info tab.`, key))
    .catch((e) => console.error("changelog save:", e.message));
  store.save().catch(() => {});
  return e;
}
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
      await refreshBoard().catch((e) => console.error("games board:", e.message));
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
      await refreshBoard().catch((e) => console.error("games board:", e.message));
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
    case "freefeature": {
      const [game, feature] = o.getString("feature").split(":");
      const on = o.getString("state") === "on";
      const ff = (store.data.freeFeatures ||= {});
      const list = new Set(ff[game] || []);
      if (on) list.add(feature); else list.delete(feature);
      if (list.size) ff[game] = [...list]; else delete ff[game];
      await store.save();
      const name = FEATURES.find((f) => f.value === o.getString("feature")).name;
      return reply(i, { content: `**${name}** is now ${on ? "free for everyone" : "key-only again"}. Takes effect next time the script loads.` });
    }
    case "panel":
      await i.deferReply({ ephemeral: true }); // the banner upload can take a few seconds
      await i.channel.send(o.getString("type") === "control" ? controlPanel() : getKeyPanel());
      return reply(i, { content: "Panel posted." });

    case "generatekey": {
      await i.deferReply({ ephemeral: true });
      const plan = o.getString("plan"), minutes = parseDuration(o.getString("duration"));
      if (minutes === 0 || minutes > 5_256_000) return i.editReply({ content: "Use a duration from 1m to 10y, or lifetime." });
      // all at once, so the reply is quick and never has to go through the slow route
      const made = await Promise.allSettled(Array.from({ length: o.getInteger("amount") || 1 }, () => jnkie.generate(plan, minutes)));
      const keys = made.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const bad = made.filter((r) => r.status === "rejected");
      const err = bad.length ? `\n${bad.length} failed: ${bad[0].reason.message}` : "";
      console.log(`[keys] ${i.user.id} made ${keys.length} ${plan} (${minutes || "lifetime"})`);
      return i.editReply({ content: keys.length ? `${keys.length} ${plan} key(s), ${o.getString("duration")}. They start when redeemed.\n${lua(keys.join("\n"))}${err}` : `No keys made.${err}` });
    }

    case "hwidcooldown": {
      const minutes = parseDuration(o.getString("duration") || "1d");
      if (minutes === null || minutes > 525_600) return reply(i, { content: "Use a duration up to 1y, e.g. 12h or 1d." });
      store.data.hwidCooldown = minutes;
      await store.save();
      return reply(i, { content: `HWID reset cooldown is now ${o.getString("duration") || "1d"}.` });
    }

    case "tempkeys": {
      await i.deferReply({ ephemeral: true });
      const list = await jnkie.tempKeys();
      const who = o.getUser("revoke");
      if (who) {
        const mine = list.filter((k) => k.discord_id === who.id);
        for (const k of mine) await jnkie.unwhitelist(k);
        const left = await jnkie.keyFor(who.id);
        if (mine.length && !(jnkie.active(left) && jnkie.isPaid(jnkie.planOf(left)))) await premiumRole(i.guild, who.id, false);
        return i.editReply({ content: `${who}: ${mine.length} timed premium key(s) revoked.` });
      }
      const rows = list.map((k) => `${k.discord_id ? `<@${k.discord_id}>` : "no Discord"} ${jnkie.tierOf(k)}, ${k.noEnd ? `no end date (made ${when(k.created_at)}, ${Math.round(k.validity_minutes / 1440 * 10) / 10}d)` : `ends ${when(k.expires_at)}`}`);
      return i.editReply({ embeds: [brand(new EmbedBuilder()).setTitle(`Timed premium (${list.length})`).setDescription(rows.join("\n").slice(0, 4000) || "Nobody.")] });
    }

    case "games":
      return i.reply({ embeds: [gamesEmbed()] });

    case "features":
      return i.reply({ ephemeral: true, embeds: [featuresEmbed()], components: [featuresMenu()] });

    case "gamesboard": {
      await i.deferReply({ ephemeral: true });
      const ch = o.getChannel("channel") || i.channel;
      store.data.gamesBoard = { ...store.data.gamesBoard, channel: ch.id, sig: null };
      await refreshBoard();
      return i.editReply(`Games board is in ${ch}. It replaces itself whenever the list changes.`);
    }

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
        for (const k of (await jnkie.keysFor(user.id)).filter(jnkie.active)) await jnkie.unwhitelist(k); // every key, not just the main one
        await syncRole(i.guild, user.id, null);
        return i.editReply({ content: `${user}'s access is revoked.` });
      }
      await resetDevice(key); // resethwid
      await setReset(user.id, null);
      return i.editReply({ content: `${user}'s HWID is reset.` });
    }

    case "blacklist": {
      await i.deferReply({ ephemeral: true });
      const user = o.getUser("user");
      const key = await jnkie.keyFor(user.id);
      if (!key) return i.editReply({ content: `${user} has no key, so there are no devices to ban.` });
      if (o.getSubcommand() === "add") {
        let n = 0;
        for (const k of await jnkie.keysFor(user.id)) n += await jnkie.blacklist(k, o.getString("reason"));
        await syncRole(i.guild, user.id, null);
        return i.editReply({ content: `${user} blacklisted: key revoked, ${n} HWID(s) banned.` });
      }
      let n = 0;
      for (const k of await jnkie.keysFor(user.id)) n += await jnkie.unblacklist(k);
      return i.editReply({ content: `${user}: ${n} HWID(s) unbanned. Use /whitelist add to give access back.` });
    }

    case "announce": {
      const e = brand(new EmbedBuilder()).setTitle(o.getString("title"))
        .setDescription(lines(o.getString("message")).join("\n")).setTimestamp();
      const img = o.getAttachment("image");
      if (img) e.setImage(img.url);
      return post(i, e);
    }

    case "notify": {
      const n = await changelog.notify(o.getString("message"), o.getString("game"));
      return reply(i, { content: `Sent in-game${n.game ? ` to ${n.game} players` : " to everyone"}: ${n.text}` });
    }
    case "update": {
      const e = updateEmbed(o.getString("game"), o.getString("version"), o.getString("type"), (k) => o.getString(k));
      if (!e) return reply(i, { content: "Add at least one change (added, improved, fixed, removed or private)." });
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

    case "faq": {
      const sub = o.getSubcommand();
      if (sub === "add") { const e = await changelog.faqAdd(o.getString("question"), o.getString("answer")); return reply(i, { content: `Added FAQ \`${e.id}\`. Run /faq post to publish.` }); }
      if (sub === "remove") { await changelog.faqRemove(Number(o.getString("id"))); return reply(i, { content: "Removed. Run /faq post to update (its forum thread, if any, stays — delete it by hand)." }); }
      if (sub === "list") {
        const list = changelog.faqList();
        return reply(i, { content: list.length ? list.map((e) => `\`${e.id}\` — ${e.q}`).join("\n").slice(0, 1900) : "No FAQ entries yet. Run /faq seed for the starters." });
      }
      if (sub === "seed") {
        const have = new Set(changelog.faqList().map((e) => e.q));
        let n = 0;
        for (const [q, a] of FAQ_SEED) if (!have.has(q)) { await changelog.faqAdd(q, a); n++; }
        return reply(i, { content: `Added ${n} starter FAQ ${n === 1 ? "entry" : "entries"}. Run /faq post to publish.` });
      }
      // post
      await i.deferReply({ ephemeral: true });
      const ch = o.getChannel("channel");
      const list = changelog.faqList();
      if (!list.length) return reply(i, { content: "No FAQ entries. Run /faq seed first." });
      if (ch.type === ChannelType.GuildForum) {
        let made = 0, edited = 0;
        for (const e of list) {
          const body = { embeds: [brand(new EmbedBuilder()).setTitle(e.q).setDescription(e.a)] };
          const existing = e.threadId && await ch.threads.fetch(e.threadId).catch(() => null);
          if (existing) { const starter = await existing.fetchStarterMessage().catch(() => null); if (starter) { await starter.edit(body); edited++; } }
          else { const th = await ch.threads.create({ name: e.q, message: body }); await changelog.faqSetThread(e.id, th.id); made++; }
        }
        return reply(i, { content: `FAQ posted to ${ch}: ${made} new thread(s), ${edited} updated.` });
      }
      // text channel: one self-updating embed
      const e = brand(new EmbedBuilder()).setTitle("ECC00 FAQ").setThumbnail(LOGO);
      for (const f of list.slice(0, 25)) e.addFields({ name: f.q, value: f.a.slice(0, 1024) });
      const prev = store.data.faqMsg && await ch.messages.fetch(store.data.faqMsg).catch(() => null);
      if (prev) await prev.edit({ embeds: [e] }); else { const m = await ch.send({ embeds: [e] }); store.data.faqMsg = m.id; await store.save(); }
      return reply(i, { content: `FAQ posted in ${ch}.` });
    }

    case "gate": {
      const g = gate.settings();
      const sub = o.getSubcommand();
      const target = o.getString("target");
      const nameOf = (k) => k === "loader" ? "the loader" : k === "universal" ? "Universal" : (gate.gameList().find((x) => x.key === k)?.name || k);
      let msg;
      if (sub === "mode") {
        const mode = o.getString("mode");
        if (target === "loader") { if (mode !== "default") g.defaultMode = mode; }
        else if (mode === "default") delete g.modes[target];
        else g.modes[target] = mode;
        msg = `Key mode for ${nameOf(target)}: **${target === "loader" ? g.defaultMode : (g.modes[target] || `loader default (${g.defaultMode})`)}**.`;
      } else if (sub === "game") {
        if (o.getString("state") === "off") g.off[target] = true; else delete g.off[target];
        msg = `${nameOf(target)} is now **${g.off[target] ? "off" : "on"}**.`;
      } else if (sub === "maintenance") {
        g.maintenance = o.getString("message") || null;
        msg = g.maintenance ? `Loader in maintenance: "${g.maintenance}"` : "Maintenance ended.";
      } else if (sub === "verify") {
        g.verifyChannel = o.getChannel("channel").id;
        msg = `Players now type their phrase in ${o.getChannel("channel")}.`;
      } else if (sub === "unlink") {
        const n = gate.dropLinksOf(o.getUser("user").id);
        return reply(i, { content: `Removed ${n} link(s) for ${o.getUser("user")}.` });
      } else {
        const modes = Object.entries(g.modes).map(([k, m]) => `${nameOf(k)}: ${m}`).join("\n") || "none";
        const off = Object.keys(g.off).map(nameOf).join(", ") || "none";
        return reply(i, { embeds: [brand(new EmbedBuilder()).setTitle("Loader setup").addFields(
          { name: "Default mode", value: g.defaultMode, inline: true },
          { name: "Maintenance", value: g.maintenance || "off", inline: true },
          { name: "Verify channel", value: g.verifyChannel ? `<#${g.verifyChannel}>` : "not set", inline: true },
          { name: "Per-game modes", value: modes.slice(0, 1024) },
          { name: "Turned off", value: off.slice(0, 1024) },
          { name: "Linked players", value: String(gate.links.size), inline: true },
        )] });
      }
      await store.save();
      return reply(i, { content: msg });
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
      if (!["roblox", "ecc00", "pc"].includes(tag)) {
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
const opening = new Set();
async function ticketButton(i, action) {
  if (action === "close") return openTicket(i, action);
  if (opening.has(i.user.id)) return reply(i, { content: "Already opening your ticket." }); // double click
  opening.add(i.user.id);
  try { return await openTicket(i, action); } finally { opening.delete(i.user.id); }
}
async function openTicket(i, action) {
  const guild = i.guild;
  if (action === "close") {
    if (!(i.channel.topic || "").startsWith("ticket:")) return reply(i, { content: "This isn't a ticket." });
    await i.reply({ content: "Closing in 5 seconds." });
    return setTimeout(() => i.channel.delete().catch(() => {}), 5000);
  }
  const open = guild.channels.cache.find((c) => c.topic === `ticket:${i.user.id}`);
  if (open) return reply(i, { content: `You already have a ticket: ${open}` });
  await reply(i, { content: "Opening your ticket. You'll be pinged in it." }); // answered now: making the channel can be slow
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
    embeds: [brand(new EmbedBuilder()).setTitle(action === "buy" ? "Buy Premium" : "Ticket opened")
      .setDescription(action === "buy" ? `${PRICES}\n\nSay which length you want and how you'd like to pay. Staff will be with you soon.`
        : "Tell us what you need and staff will be with you soon. Press Close when you're done.")],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket:close").setLabel("Close").setStyle(ButtonStyle.Danger))],
  });
  i.editReply(`Ticket opened: ${ch}`).catch(() => {}); // nice to have, the ping is what counts
}

client.on(Events.MessageCreate, (m) => gate.onMessage(m).catch((e) => console.error("verify:", e.message)));
client.on(Events.GuildMemberRemove, gate.onLeave);

client.on(Events.InteractionCreate, async (i) => {
  lazy(i);
  const what = i.commandName || i.customId || "?";
  const slow = setTimeout(() => { // never leave anyone on "thinking"
    console.error("slow interaction:", what);
    if (i.deferred && !i.replied) i.editReply({ content: `${what} is taking too long. Try again in a minute.` }).catch((e) => console.error("slow reply:", e.message));
  }, 30_000);
  try {
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isStringSelectMenu() && i.customId === "features") return await i.update({ embeds: [featuresEmbed(i.values[0])], components: [featuresMenu()] });
    if (i.isModalSubmit() && i.customId === "redeem") return await redeemModal(i);
    if (i.isButton() && i.customId.startsWith("paid:")) return await paidButton(i, i.customId.slice(5));
    if (i.isButton() && i.customId.startsWith("ticket:")) return await ticketButton(i, i.customId.slice(7));
  } catch (e) {
    console.error("interaction:", what, e.code || "", e.message); // 40060/10062 = another copy of the bot answered first
    if (i.isRepliable()) reply(i, { content: "Something broke: " + e.message }).catch((x) => console.error("error reply:", what, x.message));
  } finally { clearTimeout(slow); }
});

// Get-key card in the verify channel: every 100 min the old one goes and a fresh one sits at the bottom.
const STICKY_MIN = 100;
async function verifySticky() {
  const g = gate.settings();
  if (!g.verifyChannel) return;
  const ch = client.channels.cache.get(g.verifyChannel) || await client.channels.fetch(g.verifyChannel).catch(() => null);
  if (!ch) return;
  const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
  if (store.data.verifySticky) await ch.messages.delete(store.data.verifySticky).catch(() => {}); // however far up it is
  for (const m of recent?.values() || []) {
    if (m.author.id === client.user.id && m.embeds[0]?.title === "Get your ECC00 key") await m.delete().catch(() => {});
  }
  const msg = await ch.send(getKeyPanel());
  store.data.verifySticky = msg.id;
  await store.save();
}

// Hourly: anyone whose paid keys have all ended loses their tier role.
async function dropLapsed() {
  const guild = store.home(client);
  if (!guild || !jnkie.ready()) return;
  const ids = await jnkie.lapsed();
  const premium = guild.roles.cache.find((r) => r.name.toLowerCase() === "premium");
  if (!premium) return;
  for (let n = 0; n < ids.length; n += 100) { // only the premium role: dev/staff/owner are given by hand
    const members = await guild.members.fetch({ user: ids.slice(n, n + 100) });
    for (const m of members.values()) if (m.roles.cache.has(premium.id)) await m.roles.remove(premium).catch((e) => console.error("lapsed role:", e.message));
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`[+] ECC00 bot online as ${client.user.tag}`);
  try { await store.load(client); } catch (e) { console.error("store load:", e.message); }
  try { await changelog.load(client); } catch (e) { console.error("changelog load:", e.message); }
  try { await gate.load(client); } catch (e) { console.error("gate load:", e.message); }
  await registerCommands();
  applyStatus();
  setInterval(applyStatus, 60_000);
  tracker.start(client, brand);
  refreshBoard().catch((e) => console.error("games board:", e.message)); // catches lists changed by a deploy
  verifySticky().catch((e) => console.error("verify sticky:", e.message));
  setInterval(() => verifySticky().catch((e) => console.error("verify sticky:", e.message)), STICKY_MIN * 60_000);
  const sweep = () => dropLapsed().catch((e) => console.error("lapsed:", e.message));
  sweep();
  setInterval(sweep, 60 * 60_000);
});

require("./spotify")(app, express, limited); // Spotify addon: /spotify login, /api/spotify/*
require("./skins")(app, express, client); // MM2 spoofer skin library: /api/mm2/skins
app.listen(PORT, () => console.log(`[+] web on :${PORT}`));

// Render's free tier sleeps a web service after ~15 idle minutes and takes the bot down with it, so the
// service pings itself to stay awake.
// ponytail: self-ping keeps it up 24/7 on the free plan; drop it if this ever moves to a paid plan.
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL + "/health").catch(() => {}), 10 * 60_000);
if (DISCORD_BOT_TOKEN) client.login(DISCORD_BOT_TOKEN).catch((e) => console.error("login:", e.message));
else console.log("[!] no DISCORD_BOT_TOKEN — web only");
