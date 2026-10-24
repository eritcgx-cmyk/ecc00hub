// JNKIE REST API v2 (docs.jnkie.com/rest-api). The whitelist IS JNKIE: one premium key per Discord user,
// tied to them with discord_id, so the script gets their name/avatar through JD_* runtime vars and the
// bot can look them up, reset their HWID, or ban them without a database of our own.
const BASE = "https://api.jnkie.com/api/v2";
const PROVIDER_ID = Number(process.env.JNKIE_PROVIDER_ID || 29015); // "ECC00 Premium", covers every service

const ready = () => Boolean(process.env.JNKIE_API_KEY);

async function api(method, path, body) {
  if (!ready()) throw new Error("JNKIE_API_KEY is not set on the server");
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.JNKIE_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || `JNKIE ${r.status}`);
  return data;
}

// Tier lives in the key name ("ECC00 premium") so it shows up in the dashboard too.
const TIER_PREFIX = "ECC00 ";
const tierOf = (key) => (key.key_name || "").startsWith(TIER_PREFIX) ? key.key_name.slice(TIER_PREFIX.length) : "premium";

const expired = (key) => key.expires_at && new Date(key.expires_at) <= new Date();
const active = (key) => Boolean(key && !key.is_invalidated && !expired(key));

// A user's whitelist entry: their newest key, or null.
async function keyFor(discordId) {
  const { keys = [] } = await api("GET", `/keys?discord_id=${discordId}&limit=50`);
  return keys.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

// Add or renew. Reuses the existing key so the user's saved loadstring keeps working.
async function whitelist(discordId, tier, minutes) {
  const existing = await keyFor(discordId);
  if (existing) {
    await api("PUT", `/keys/${existing.id}`, {
      key_name: TIER_PREFIX + tier,
      is_premium: true,
      is_invalidated: false,
      // expires_at is what actually moves the deadline on an existing key; null = forever
      expires_at: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
    });
    return keyFor(discordId);
  }
  const { key } = await api("POST", "/keys", {
    provider_id: PROVIDER_ID,
    discord_id: String(discordId),
    key_name: TIER_PREFIX + tier,
    is_premium: true,
    validity_minutes: minutes || null,
    hwid_limit: 1,
  });
  return key;
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

module.exports = { ready, ping, keyFor, whitelist, unwhitelist, resetHwid, blacklist, unblacklist, tierOf, active, expired, hwidsOf };
