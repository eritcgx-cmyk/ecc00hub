// JNKIE REST API v2 (docs.jnkie.com/rest-api). The whitelist IS JNKIE: one premium key per Discord user,
// tied to them with discord_id, so the script gets their name/avatar through JD_* runtime vars and the
// bot can look them up, reset their HWID, or ban them without a database of our own.
const BASE = "https://api.jnkie.com/api/v2";
const PROVIDER_ID = Number(process.env.JNKIE_PROVIDER_ID || 29015); // "ECC00 Premium", covers every service
const BASIC_PLUS_PROVIDER = Number(process.env.JNKIE_BASICPLUS_PROVIDER_ID || 32149);

const ready = () => Boolean(process.env.JNKIE_API_KEY);

async function api(method, path, body) {
  if (!ready()) throw new Error("JNKIE_API_KEY is not set on the server");
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.JNKIE_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000), // a stuck request must fail, not leave Discord on "thinking"
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || `JNKIE ${r.status}`);
  return data;
}

// Tier lives in the key name ("ECC00 premium") so it shows up in the dashboard too.
const TIER_PREFIX = "ECC00 ";
const tierOf = (key) => (key.key_name || "").startsWith(TIER_PREFIX) ? key.key_name.slice(TIER_PREFIX.length) : "premium";

// Plan of a key: premium keys carry their tier in the name; free keys are Basic, unless they came from the
// "ECC00 Basic+" provider (2 Lootlabs checkpoints). Keys from /generatekey are named "ECC00 staff <plan>".
const STAFF = /^ECC00 staff (free|basic\+)$/;
const staffKey = (key) => STAFF.test(key.key_name || "");
const planOf = (key) => key.is_premium ? tierOf(key)
  : staffKey(key) ? STAFF.exec(key.key_name)[1]
  : /basic\s*\+|plus/i.test(key.provider_name || "") ? "basic+" : "free";
const isPaid = (plan) => plan !== "free" && plan !== "basic+";

const expired = (key) => key.expires_at && new Date(key.expires_at) <= new Date();
const active = (key) => Boolean(key && !key.is_invalidated && !expired(key));

const keysFor = async (discordId) => (await api("GET", `/keys?discord_id=${discordId}&limit=100`)).keys || [];
// A user's main key: active beats dead, then the better plan, then the later end, then the newer one.
const rank = (k) => [active(k) ? 1 : 0, isPaid(planOf(k)) ? 2 : planOf(k) === "basic+" ? 1 : 0,
  k.expires_at ? Date.parse(k.expires_at) : Infinity, Date.parse(k.created_at) || 0];
function best(keys) {
  return [...keys].sort((a, b) => {
    const x = rank(a), y = rank(b), n = x.findIndex((v, i) => v !== y[i]);
    return n < 0 ? 0 : y[n] > x[n] ? 1 : -1;
  })[0] || null;
}
const keyFor = async (discordId) => best(await keysFor(discordId));
async function allKeys() {
  const out = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const d = await api("GET", `/keys?limit=100&page=${page}`);
    out.push(...(d.keys || []));
    pages = d.pagination?.totalPages || 1;
  }
  return out;
}

// The key a script was run with (getgenv().SCRIPT_KEY), or null.
async function keyByValue(value) {
  const { keys = [] } = await api("GET", `/keys?key=${encodeURIComponent(value)}&limit=1`);
  return keys.find((k) => k.key_value === value) || null;
}

const until = (minutes, from = Date.now()) => (minutes ? new Date(from + minutes * 60_000).toISOString() : null);
// expires_at is the only deadline the bot trusts, so every write sets it (null = forever)
const deadline = (iso) => ({ expires_at: iso, validity_minutes: null, expiry_on_first_use: false });

// Add or renew. Reuses the existing premium key so the user's saved loadstring keeps working.
async function whitelist(discordId, tier, minutes) {
  const set = { key_name: TIER_PREFIX + tier, is_premium: true, is_invalidated: false, ...deadline(until(minutes)) };
  let existing = best((await keysFor(discordId)).filter((k) => k.is_premium));
  if (!existing) {
    ({ key: existing } = await api("POST", "/keys", {
      provider_id: PROVIDER_ID,
      discord_id: String(discordId),
      key_name: TIER_PREFIX + tier,
      is_premium: true,
      validity_minutes: minutes || null,
      hwid_limit: 1,
    }));
  }
  await api("PUT", `/keys/${existing.id}`, set);
  return { ...existing, ...set };
}

// /generatekey: the key is made dead ("pending") and only starts working, and counting down, once someone
// redeems it. Pending keys are invalidated and not premium, so the raw key is useless in any loader.
const PENDING = /^ECC00 pending (free|basic\+|premium) (\d+)$/; // minutes, 0 = lifetime
const isPending = (key) => PENDING.test(key?.key_name || "");
async function generate(plan, minutes) {
  // free keys use the Basic+ provider too: the premium one covers the paid games' JNKIE scripts
  const { key } = await api("POST", "/keys", {
    provider_id: plan === "premium" ? PROVIDER_ID : BASIC_PLUS_PROVIDER,
    key_name: `ECC00 pending ${plan} ${minutes || 0}`,
    is_premium: false,
    validity_minutes: null,
    hwid_limit: 1,
  });
  try { await api("PUT", `/keys/${key.id}`, { is_invalidated: true }); }
  catch (e) { await api("DELETE", `/keys/${key.id}`).catch(() => {}); throw e; } // never leave a live one behind
  return key.key_value;
}

// Redeem for a Discord user. Already on that plan: their own key is extended and the new one is used up, so
// the loadstring they saved keeps working. Throws with a message for the user.
const redeeming = new Set();
async function redeem(discordId, value) {
  if (redeeming.has(value) || redeeming.has(discordId)) throw new Error("Already redeeming, wait a second.");
  redeeming.add(value); redeeming.add(discordId);
  try {
    const key = await keyByValue(value);
    if (!key) throw new Error("That key doesn't exist.");
    const m = PENDING.exec(key.key_name || "");
    if (!m) { // a checkpoint key: just tie it to this Discord account
      if (!active(key)) throw new Error("That key is expired or already used.");
      if (key.discord_id) throw new Error(key.discord_id === String(discordId) ? "That key is already yours." : "That key belongs to someone else.");
      await api("PUT", `/keys/${key.id}`, { discord_id: String(discordId) });
      return { ...key, discord_id: String(discordId) };
    }
    const plan = m[1], minutes = Number(m[2]);
    const mine = best((await keysFor(discordId)).filter((k) => active(k)
      && (plan === "premium" ? isPaid(planOf(k)) : staffKey(k) && planOf(k) === plan)));
    if (mine && !mine.expires_at) throw new Error("You already have this plan for life. The key wasn't used.");
    if (mine) {
      const ends = minutes ? until(minutes, Date.parse(mine.expires_at)) : null;
      await api("PUT", `/keys/${key.id}`, { key_name: "ECC00 redeemed", is_invalidated: true });
      try { await api("PUT", `/keys/${mine.id}`, deadline(ends)); }
      catch (e) { await api("PUT", `/keys/${key.id}`, { key_name: key.key_name }); throw e; }
      return { ...mine, expires_at: ends };
    }
    const set = {
      key_name: plan === "premium" ? "ECC00 premium" : `ECC00 staff ${plan}`,
      is_premium: plan === "premium",
      is_invalidated: false,
      discord_id: String(discordId),
      ...deadline(until(minutes)),
    };
    await api("PUT", `/keys/${key.id}`, set);
    return { ...key, ...set };
  } finally { redeeming.delete(value); redeeming.delete(discordId); }
}

// Active premium keys that aren't plain lifetime, for /tempkeys. noEnd = sold with a length but JNKIE holds no
// end date; a lifetime renewal of an older key looks the same, so staff decide.
async function tempKeys() {
  return (await allKeys()).filter((k) => k.is_premium && active(k) && (k.expires_at || k.validity_minutes))
    .map((k) => ({ ...k, noEnd: !k.expires_at }));
}
// Discord ids whose paid keys have all ended (they lose the tier role). Never had a paid key = not listed.
async function lapsed() {
  const had = new Set(), has = new Set();
  for (const k of await allKeys()) {
    if (!k.is_premium || !k.discord_id) continue;
    had.add(k.discord_id);
    if (active(k)) has.add(k.discord_id);
  }
  return [...had].filter((id) => !has.has(id));
}

// Mint a test Basic+ key (non-premium, from the "ECC00 Basic+" provider so planOf sees it as basic+).
// For testing the Basic+ tier; it unlocks Auto Farm only, never full premium.
async function basicPlusKey(minutes) {
  const { key } = await api("POST", "/keys", {
    provider_id: BASIC_PLUS_PROVIDER,
    key_name: "ECC00 Basic+",
    is_premium: false,
    validity_minutes: minutes || 1440,
    hwid_limit: 1,
  });
  return key.key_value;
}

const unwhitelist = (key) => api("PUT", `/keys/${key.id}`, { is_invalidated: true });
const resetHwid = (key) => api("POST", `/keys/${key.id}/reset-hwid`);
const hwidsOf = (key) => key.keys_hwid || key.hwids || [];

// Blacklist = invalidate the key and ban every HWID it was used from.
async function blacklist(key, reason) {
  await unwhitelist(key);
  const hwids = hwidsOf(key);
  for (const hwid of hwids) {
    await api("POST", "/hwid-bans", { hwid, reason: reason || "ECC00 blacklist", invalidate_keys: true });
  }
  return hwids.length;
}
async function unblacklist(key) {
  const hwids = hwidsOf(key);
  for (const hwid of hwids) await api("DELETE", `/hwid-bans/by-hwid/${encodeURIComponent(hwid)}`).catch(() => {});
  return hwids.length;
}

// Cheap authenticated call, so a bad key shows up as an error instead of "configured".
const ping = () => api("GET", "/services").then((d) => (d.services || d).length);

module.exports = { best, isPaid, isPending, staffKey, keysFor, generate, redeem, tempKeys, lapsed, planOf, ready, ping, keyFor, keyByValue, whitelist, basicPlusKey, unwhitelist, resetHwid, blacklist, unblacklist, tierOf, active, expired, hwidsOf };
