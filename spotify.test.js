// node spotify.test.js  -- token sealing + LRC parsing
process.env.GATE_SECRET = "test";
const assert = require("assert");
const { seal, open, parseLrc } = require("./spotify")._test;
const t = seal({ r: "refresh123", p: true, n: "Ira" });
assert.deepStrictEqual(open(t), { r: "refresh123", p: true, n: "Ira" }, "token round-trips");
assert.equal(open(t.slice(0, -2) + "xx"), null, "tampered token is rejected");
process.env.GATE_SECRET = "other";
assert.equal(open(t), null, "another server's key can't read it");
assert.deepStrictEqual(parseLrc("[00:12.50] Hello\n[01:02.00]World\nnot a line"), [{ t: 12.5, l: "Hello" }, { t: 62, l: "World" }]);
console.log("spotify ok");
