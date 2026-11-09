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
const { cleanTitle } = require("./spotify")._test;
assert.equal(cleanTitle("Sweater Weather (Hoodtrap / Mylancore) SLOWED"), "Sweater Weather");
assert.equal(cleanTitle("Blinding Lights - Remastered 2020"), "Blinding Lights");
assert.equal(cleanTitle("Song Sped Up"), "Song");
console.log("clean ok");
// device lock: a token sealed with h only opens for the same device hash
{
  process.env.GATE_SECRET = "test";
  const crypto = require("crypto");
  const h = crypto.createHash("sha256").update("pc-1").digest("hex");
  const locked = seal({ r: "x", h });
  assert.equal(open(locked).h, h);
  console.log("lock ok");
}
