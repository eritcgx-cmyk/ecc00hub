// Self-check: `node check.js`. Runs the tracker against live WEAO with fake channels, and the JNKIE helpers
// against fake keys. Exits non-zero on the first failure.
const assert = require("assert");
const { ChannelType, EmbedBuilder } = require("discord.js");
const tracker = require("./tracker");
const jnkie = require("./jnkie");

function fakeChannel(name, topic) {
  return {
    type: ChannelType.GuildText, name, topic, sent: [],
    async setName(n) { this.name = n; }, async setTopic(t) { this.topic = t; }, async send(m) { this.sent.push(m); },
  };
}

(async () => {
  const volt = fakeChannel("╠➣〢🔴〢𝐕𝐨𝐥𝐭-𝐒𝐭𝐚𝐭𝐮𝐬", "weao:Volt");
  const roblox = fakeChannel("roblox-updates", "weao:roblox version-old000000000");
  const fresh = fakeChannel("roblox-updates-2", "weao:roblox");
  const untouched = fakeChannel("general", "chat here");
  const channels = [volt, roblox, fresh, untouched];
  const client = { channels: { cache: { filter: (f) => { const m = new Map(channels.filter(f).map((c, i) => [i, c])); m.size; return m; } } } };

  const live = (await tracker.exploits()).find((e) => e.title === "Volt");
  await tracker.tick(client, (e) => e);

  assert.ok(volt.name.includes(live.updateStatus ? "🟢" : "🔴"), "volt dot follows WEAO updateStatus");
  assert.ok(volt.name.endsWith("𝐕𝐨𝐥𝐭-𝐒𝐭𝐚𝐭𝐮𝐬"), "rest of the name is untouched");
  assert.ok(tracker.latest.roblox?.startsWith("version-"), "latest roblox version recorded");
  assert.strictEqual(roblox.sent.length, 1, "a changed roblox version is announced");
  assert.strictEqual(roblox.topic, `weao:roblox ${tracker.latest.roblox}`, "topic stores the new version");
  assert.strictEqual(fresh.sent.length, 0, "first sighting only records, never announces");
  assert.strictEqual(untouched.name, "general");

  // second tick: nothing changed, so nothing is sent and nothing renamed
  const before = volt.name;
  await tracker.tick(client, (e) => e);
  assert.strictEqual(roblox.sent.length, 1, "no repeat announcement");
  assert.strictEqual(volt.name, before);

  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.ok(jnkie.active({ is_invalidated: false, expires_at: null }), "lifetime key is active");
  assert.ok(jnkie.active({ is_invalidated: false, expires_at: future }));
  assert.ok(!jnkie.active({ is_invalidated: false, expires_at: past }), "expired key is not active");
  assert.ok(!jnkie.active({ is_invalidated: true, expires_at: null }), "revoked key is not active");
  assert.ok(!jnkie.active(null), "no key is not active");
  assert.strictEqual(jnkie.tierOf({ key_name: "ECC00 dev" }), "dev");
  assert.strictEqual(jnkie.tierOf({ key_name: "something else" }), "premium");

  console.log("ok: volt", volt.name, "| roblox", tracker.latest.roblox);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
