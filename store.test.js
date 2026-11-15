// node store.test.js  -- the store message switches to an attachment once the JSON outgrows 2000 chars
const assert = require("assert");
const store = require("./store");
const { payload, read, isStore } = store._test;

(async () => {
  store.data.versions = { ftf: "3.4" };
  let p = payload();
  assert.ok(p.content.startsWith("```json") && p.files.length === 0, "small data stays in the message");
  assert.deepEqual((await read({ content: p.content, attachments: [] })).versions, { ftf: "3.4" });

  store.data.versions = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["game" + i, "1." + i]));
  p = payload();
  assert.ok(p.content.length < 2000 && p.files.length === 1, "big data goes into an attachment");
  const json = p.files[0].attachment.toString();
  global.fetch = async () => ({ text: async () => json });
  const att = [{ name: "data.json", url: "x" }];
  const msg = { author: { id: "bot" }, content: p.content, attachments: att };
  assert.ok(isStore(msg, "bot"), "attachment message is still found on load");
  assert.equal((await read(msg)).versions.game199, "1.199", "and reads back");
  console.log("store ok");
})().catch((e) => { console.error(e); process.exit(1); });
