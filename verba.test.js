// node verba.test.js  -- mention -> Verba call with the mention stripped -> reply; non-mentions ignored
process.env.VERBA_API_KEY = "k"; process.env.VERBA_CHARACTER = "ecc00";
const assert = require("assert");
const verba = require("./verba");

let sent;
global.fetch = async (url, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: "hi!" } }] }) }; };
const client = { user: { id: "1" } };
const msg = (content, mentioned) => ({
  content, author: { id: "9", bot: false }, guild: {}, channelId: "c",
  mentions: { users: new Map(mentioned ? [["1", {}]] : []), repliedUser: null },
  channel: { sendTyping: async () => {} }, react: async () => {},
  reply: async (r) => (msg.out = r.content),
});

(async () => {
  await verba.onMessage(msg("<@1> what is ecc00?", true), client, "verify");
  assert.deepStrictEqual(sent, { character: "ecc00", session_id: "discord-9", messages: [{ role: "user", content: "what is ecc00?" }] });
  assert.strictEqual(msg.out, "hi!");
  sent = null;
  await verba.onMessage(msg("<@1> again", true), client, "verify"); // within 5s cooldown
  assert.strictEqual(sent, null);
  await verba.onMessage(msg("no ping", false), client, "verify");
  assert.strictEqual(sent, null);
  console.log("verba ok");
})();
