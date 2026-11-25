// node jnkie.test.js  -- generate, redeem, renew and expiry against a fake JNKIE
process.env.JNKIE_API_KEY = "x";
const assert = require("assert");
let db = [], id = 0, fail = null, drop = null;
global.fetch = async (url, { method, body }) => {
  const u = new URL(url), b = body && JSON.parse(body), one = db.find((k) => u.pathname.endsWith("/keys/" + k.id));
  const ok = (d) => ({ ok: true, json: async () => d });
  if (fail && fail(method, one, b)) return { ok: false, status: 500, json: async () => ({ error: "down" }) };
  if (method === "POST") {
    const k = { id: ++id, key_value: `KEYVALUE${id}X`, created_at: new Date().toISOString(), is_invalidated: false, expires_at: null, ...b };
    db.push(k);
    return ok({ key: { ...k } });
  }
  if (method === "PUT") { Object.assign(one, b, drop && drop(b)); return ok({ success: true }); }
  if (method === "DELETE") { db = db.filter((k) => k !== one); return ok({}); }
  if (one) return ok({ key: { ...one } });
  const q = u.searchParams;
  const keys = db.filter((k) => (!q.get("discord_id") || k.discord_id === q.get("discord_id")) && (!q.get("key") || k.key_value.includes(q.get("key"))));
  return ok({ keys: keys.map((k) => ({ ...k })), pagination: { totalPages: 1 } });
};
const j = require("./jnkie");
const days = (k) => Math.round((Date.parse(k.expires_at) - Date.now()) / 864e5);
const row = (v) => db.find((x) => x.key_value === v);

(async () => {
  fail = (m) => m === "PUT";
  await assert.rejects(j.generate("premium", 60));
  assert.equal(db.length, 0, "a key that couldn't be made dead is deleted");
  fail = null;

  const a = await j.generate("premium", 3 * 1440);
  assert.ok(!j.active(db[0]) && !db[0].is_premium, "unredeemed key is dead");
  let k = await j.redeem("100", a);
  assert.ok(j.active(k) && j.planOf(k) === "premium" && days(k) === 3, "3 day premium");
  await assert.rejects(j.redeem("200", a), /someone else/);
  const b = await j.generate("premium", 7 * 1440);
  k = await j.redeem("100", b);
  assert.ok(k.key_value === a && days(row(a)) === 10, "same plan extends the key they have");
  await assert.rejects(j.redeem("200", b), /expired or already used/);

  // JNKIE fails mid-extend: the new key isn't lost
  const c = await j.generate("premium", 1440);
  fail = (m, o, body) => m === "PUT" && o?.key_value === a && body.expires_at;
  await assert.rejects(j.redeem("100", c), /down/);
  fail = null;
  assert.ok(j.isPending(row(c)), "failed redeem leaves the key redeemable");
  const both = await Promise.allSettled([j.redeem("300", c), j.redeem("400", c)]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, "two people can't redeem one key");

  // expiry
  row(a).expires_at = new Date(Date.now() - 1).toISOString();
  assert.ok(!j.active(await j.keyFor("100")));
  assert.ok((await j.lapsed()).includes("100"), "expired premium user loses the role");
  await j.redeem("100", await j.generate("premium", 60));
  await j.redeem("100", await j.generate("premium", 0));
  k = await j.keyFor("100");
  assert.ok(j.active(k) && k.expires_at === null && !(await j.lapsed()).includes("100"), "lifetime on top of a timed key");
  await assert.rejects(j.redeem("100", await j.generate("premium", 1440)), /for life/);

  for (const plan of ["free", "basic+"]) {
    k = await j.redeem("500", await j.generate(plan, 1440));
    assert.ok(j.planOf(k) === plan && !k.is_premium && !j.isPaid(j.planOf(k)));
  }
  k = await j.whitelist("600", "premium", 3 * 1440);
  assert.equal(days(row(k.key_value)), 3, "whitelist always stores an end date");
  assert.ok((await j.tempKeys()).some((x) => x.discord_id === "600"));
  await j.whitelist("600", "premium", null);
  assert.ok((await j.keysFor("600")).length === 1 && !(await j.keyFor("600")).expires_at);
  assert.ok(!(await j.tempKeys()).some((x) => x.discord_id === "600"), "lifetime isn't temp");
  // JNKIE ignoring the end date must never leave a live, endless key behind
  const z = await j.generate("premium", 1440);
  drop = (b) => (b.expires_at ? { expires_at: null } : {});
  await assert.rejects(j.redeem("700", z), /didn't save expires_at/);
  drop = null;
  assert.ok(j.isPending(row(z)) && !j.active(row(z)) && !row(z).discord_id);
  // checkpoint keys: freeKeyHours wins over JNKIE's own date, and a fresh one beats a stale one
  const old = { created_at: new Date(Date.now() - 48 * 36e5).toISOString(), expires_at: new Date(Date.now() + 1e9).toISOString() };
  assert.ok(!j.active(old) && j.best([old, { id: 9, created_at: new Date().toISOString() }]).id === 9);
  console.log("jnkie ok");
})().catch((e) => { console.error(e); process.exit(1); });
