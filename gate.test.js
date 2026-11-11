// node gate.test.js  -- every key mode through gate.session with fake Discord/JNKIE
process.env.GATE_SECRET = "test";
const assert = require("assert");
const jnkie = require("./jnkie");
const store = require("./store");
const gate = require("./gate");

const KEYS = {
  "PREMIUMKEY1": { key_value: "PREMIUMKEY1", is_premium: true, key_name: "ECC00 premium", discord_id: "42", created_at: new Date().toISOString() },
  "FREEKEY0001": { key_value: "FREEKEY0001", is_premium: false, created_at: new Date().toISOString() },
  "FREEKEY0002": { key_value: "FREEKEY0002", is_premium: false, created_at: new Date().toISOString() },
  "OLDFREEKEY1": { key_value: "OLDFREEKEY1", is_premium: false, created_at: new Date(Date.now() - 48 * 3600e3).toISOString() },
};
jnkie.keyByValue = async (v) => KEYS[v] || null;
const client = { users: { fetch: async (id) => ({ username: "owner" + id, displayAvatarURL: () => "pfp" }) }, channels: { cache: new Map() } };
gate._setForTest({ send: async () => ({ delete: async () => {} }) }, [
  { key: "ftf", name: "Flee the Facility", file: "ftf.lua", places: [893973440] },
  { key: "da_hood", name: "Da Hood", file: "dahood.lua", places: [2788229376], paid: true },
]);
const s = gate.settings();
const ask = (o) => gate.session(client, { robloxId: "1", hwid: "pc-a", placeId: "893973440", ...o });

(async () => {
  s.maintenance = "brb";
  assert.equal((await ask({})).reason, "brb");
  s.maintenance = null;

  s.modes.ftf = "keyless";
  let r = await ask({});
  assert.ok(r.ok && r.ticket && r.tier === "free" && !r.premium);

  s.modes.ftf = "discord";
  r = await ask({});
  assert.equal(r.need, "discord");
  assert.match(r.phrase, /^ecc00 \w+ \w+ \d{3}$/);
  assert.equal((await ask({})).phrase, r.phrase, "same player+device keeps the same phrase");
  // they type it in the verify channel
  s.verifyChannel = "chan";
  await gate.onMessage({ author: { id: "7", bot: false }, channelId: "chan", content: r.phrase.toUpperCase(), delete: async () => {}, channel: { send: async () => null } });
  r = await ask({});
  assert.ok(r.ok && r.profile.username === "owner7", "linked player gets in with their Discord profile");
  assert.equal((await ask({ hwid: "pc-b" })).need, "discord", "new device verifies again");
  gate.onLeave({ id: "7" });
  assert.equal((await ask({})).need, "discord", "leaving the server drops the link");

  s.modes.ftf = "keyed";
  assert.equal((await ask({})).need, "key");
  r = await ask({ key: "FREEKEY0001" });
  assert.ok(r.ok && r.tier === "free" && !r.premium, "free checkpoint key is not premium");
  assert.equal((await ask({ key: "OLDFREEKEY1" })).need, "key", "free key past its hours is refused");
  r = await ask({ key: "PREMIUMKEY1" });
  assert.ok(r.ok && r.premium && r.profile.username === "owner42");
  assert.match((await ask({ key: "PREMIUMKEY1", hwid: "pc-b" })).reason, /another device/, "key is locked to one device");

  assert.equal((await ask({ placeId: "2788229376", key: "FREEKEY0001", hwid: "pc-a" })).need, "key", "paid game refuses free keys");
  assert.ok((await ask({ placeId: "2788229376", key: "PREMIUMKEY1" })).ok, "paid game takes premium");
  // ScriptBlox tester code: skips Discord and the device lock, never premium
  s.testerCode = "testercode123";
  s.modes.ftf = "discord";
  for (const who of [{ robloxId: "90", hwid: "pc-x" }, { robloxId: "91", hwid: "pc-y" }]) {
    r = await ask({ ...who, key: "testercode123" });
    assert.ok(r.ok && r.tier === "free" && !r.premium, "tester passes on any account and device");
  }
  assert.ok(gate.lastSeen.get("90").tester, "tester launches are marked for the logs");
  s.modes.ftf = "keyed";
  assert.ok((await ask({ key: "testercode123" })).ok, "tester passes keyed mode too");
  s.modes.ftf = "discord";
  assert.equal((await ask({ robloxId: "92", hwid: "pc-z", key: "testercode124" })).need, "key", "wrong code is just a bad key");
  assert.equal((await ask({ robloxId: "92", hwid: "pc-z" })).need, "discord", "no code still needs Discord");
  assert.equal((await ask({ placeId: "2788229376", key: "testercode123" })).need, "key", "paid game refuses tester");
  s.testerCode = null;
  assert.equal((await ask({ robloxId: "90", hwid: "pc-x", key: "testercode123" })).need, "key", "old code stops once cleared");

  // discordkey: Discord verify AND a key, in that order
  s.modes.ftf = "discordkey";
  r = await ask({ robloxId: "50", hwid: "pc-k", key: "FREEKEY0002" });
  assert.equal(r.need, "discord", "a key alone isn't enough");
  await gate.onMessage({ author: { id: "8", bot: false }, channelId: "chan", content: r.phrase, delete: async () => {}, channel: { send: async () => null } });
  assert.equal((await ask({ robloxId: "50", hwid: "pc-k" })).need, "key", "verified but no key still needs a key");
  r = await ask({ robloxId: "50", hwid: "pc-k", key: "FREEKEY0002" });
  assert.ok(r.ok && r.profile.username === "owner8", "verified + key gets in");
  assert.ok(r.premium && r.tier === "free", "discordkey: a free key unlocks every feature");
  s.off.ftf = true;
  assert.match((await ask({ key: "PREMIUMKEY1" })).reason, /turned off/);
  console.log("gate ok");
})().catch((e) => { console.error(e); process.exit(1); });
