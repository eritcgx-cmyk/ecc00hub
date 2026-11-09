const assert = require("assert");
const { clean } = require("./skins");

// a real knife as MM2 reports it (trailing spaces on the ids)
assert.deepStrictEqual(clean({ m: "http://www.roblox.com/asset/?id=121944778   ", t: "rbxassetid://121944805", s: [1, 1, 1], snd: { Throw: "rbxassetid://123" } }),
  { m: "http://www.roblox.com/asset/?id=121944778", t: "rbxassetid://121944805", s: [1, 1, 1], snd: { Throw: "rbxassetid://123" } });
// junk is refused
assert.strictEqual(clean({ m: "https://evil.example/x", t: "" }), null);
assert.strictEqual(clean(null), null);
// bad parts dropped, good kept
assert.deepStrictEqual(clean({ m: "rbxassetid://1", s: [999, 1, 1], snd: { "<x>": "rbxassetid://2" }, dual: "yes" }), { m: "rbxassetid://1", t: "" });
console.log("skins ok");
