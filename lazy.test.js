// node lazy.test.js
const assert = require("assert"), lazy = require("./lazy");
const make = () => { const log = []; return { log, i: lazy({ deferReply: async () => log.push("defer"), editReply: async (b) => log.push(["edit", b]), reply: async (b) => log.push(["reply", b]) }) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let t = make();
  await t.i.deferReply({ ephemeral: true }); await t.i.editReply("hi"); await wait(2200);
  assert.deepEqual(t.log, [["reply", { content: "hi", ephemeral: true }]], "fast work: one direct private reply, never defers");
  t = make();
  await t.i.deferReply({ ephemeral: true }); await wait(2200); await t.i.editReply({ content: "x" });
  assert.deepEqual(t.log, ["defer", ["edit", { content: "x" }]], "slow work: defer then edit");
  t = make();
  await t.i.deferReply({ ephemeral: true }); await t.i.reply({ content: "err" }); await wait(2200);
  assert.deepEqual(t.log, [["reply", { content: "err", ephemeral: true }]], "an error before the defer still answers privately");
  t = make();
  await t.i.reply({ content: "plain" });
  assert.deepEqual(t.log, [["reply", { content: "plain" }]]);
  console.log("lazy ok");
})().catch((e) => { console.error(e); process.exit(1); });
