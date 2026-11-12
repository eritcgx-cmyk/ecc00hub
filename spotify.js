// Spotify addon backend. A player logs in once with Spotify, gets a 6-digit code, types it into the
// in-game Spotify tab, and the script receives a token. The token IS the player's Spotify refresh token,
// encrypted with a key only this server has: nothing is stored here, and the token is useless to anyone
// who copies it off the player's PC without this server.
// Env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (Spotify dashboard), GATE_SECRET (already set; the key seed).
const crypto = require("crypto");
const jpeg = require("jpeg-js");

const REDIRECT = (process.env.PUBLIC_URL || "https://ecc00hub.onrender.com") + "/spotify/callback";
const SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-private";
const key = () => crypto.createHash("sha256").update((process.env.GATE_SECRET || "") + ":spotify").digest();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}
function open(token) {
  try {
    const raw = Buffer.from(String(token), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

// "[01:02.50] words" -> [{ t: 62.5, l: "words" }]
function parseLrc(lrc) {
  const out = [];
  for (const line of String(lrc || "").split("\n")) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) out.push({ t: Number(m[1]) * 60 + Number(m[2]), l: m[3].trim() });
  }
  return out;
}

// the cover's main colour: average of the 64px image, ignoring near-black/near-white pixels, then lifted
function coverColor(buf) {
  const img = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 1 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    if (max < 30 || min > 235 || max - min < 18) continue; // greys say nothing about the colour
    r += R; g += G; b += B; n++;
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  const lift = 210 / Math.max(r, g, b, 1); // bright enough to read on a black UI
  const hex = (v) => Math.min(255, Math.round(v * lift)).toString(16).padStart(2, "0");
  return hex(r) + hex(g) + hex(b);
}

// "Song (Remix) SLOWED - Remastered" -> "Song"
function cleanTitle(t) {
  return String(t).replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").replace(/\s+-\s+.*$/, "")
    .replace(/\b(slowed|reverb|sped up|speed up|nightcore|remix|8d|bass boosted|tiktok version)\b.*$/i, "").trim() || String(t);
}

async function findLyrics(it) {
  const d = (it.duration_ms || 0) / 1000;
  const artist = it.artists?.[0]?.name || "";
  const get = (u) => fetch(u, { headers: { "User-Agent": "ECC00 (eccohub.xyz)" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const exact = await get("https://lrclib.net/api/get?" + new URLSearchParams({ artist_name: artist, track_name: it.name, album_name: it.album?.name || "", duration: String(Math.round(d)) }));
  if (exact?.syncedLyrics) return { lyrics: parseLrc(exact.syncedLyrics) };
  const clean = cleanTitle(it.name);
  let list = (await get("https://lrclib.net/api/search?" + new URLSearchParams({ track_name: clean, artist_name: artist }))) || [];
  if (!list.length) list = (await get("https://lrclib.net/api/search?" + new URLSearchParams({ q: clean }))) || [];
  const same = list.filter((x) => String(x.trackName).toLowerCase() === clean.toLowerCase());
  const pool = (same.length ? same : list).filter((x) => x.syncedLyrics);
  // closest length wins; a slowed/sped edit is the same song stretched, so its timings scale with the length
  pool.sort((a, b) => Math.abs(a.duration - d) - Math.abs(b.duration - d));
  const best = pool[0];
  if (best) {
    const ratio = best.duration ? d / best.duration : 1;
    const k = ratio > 0.6 && ratio < 1.6 ? ratio : 1;
    return { lyrics: parseLrc(best.syncedLyrics).map((l) => ({ t: l.t * k, l: l.l })) };
  }
  const plain = exact?.plainLyrics || list.find((x) => x.plainLyrics)?.plainLyrics;
  return plain ? { lyrics: [], plain: plain.split("\n").filter(Boolean).slice(0, 150) } : { lyrics: [] };
}

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

module.exports = function mount(app, express, limited) {
  const states = new Map(); // oauth state -> expiry
  const codes = new Map(); // 6-digit code -> { token, name, premium, exp }
  const access = new Map(); // sha(token) -> { at, exp }
  const tracks = new Map(); // track id -> { lyrics, color } (small, bounded below)
  const configured = () => process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET;
  const basic = () => "Basic " + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET).toString("base64");

  async function tokenCall(params) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || "spotify token " + r.status);
    return j;
  }
  // access token for this player's token, refreshing when it expires. Returns { at, newToken? }.
  async function accessFor(token, device) {
    const data = open(token);
    if (!data || !data.r) return null;
    if (data.h && data.h !== sha(device || "")) return null; // copied to another device

    const id = crypto.createHash("sha256").update(token).digest("hex");
    const hit = access.get(id);
    if (hit && hit.exp > Date.now() + 5000) {
      const newToken = !data.h && device ? seal({ ...data, h: sha(device) }) : null; // lock an older token on first use
      if (newToken) access.set(sha(newToken), hit);
      return { at: hit.at, data, newToken };
    }
    const j = await tokenCall({ grant_type: "refresh_token", refresh_token: data.r });
    access.set(id, { at: j.access_token, exp: Date.now() + j.expires_in * 1000 });
    // Spotify sometimes rotates the refresh token, and tokens from before the device lock get locked now:
    // either way the player gets a new token to save
    const rotated = j.refresh_token && j.refresh_token !== data.r;
    const lockNow = !data.h && device;
    const newToken = rotated || lockNow ? seal({ ...data, r: rotated ? j.refresh_token : data.r, h: data.h || sha(device) }) : null;
    if (newToken) access.set(crypto.createHash("sha256").update(newToken).digest("hex"), access.get(id));
    return { at: j.access_token, data, newToken };
  }
  const page = (title, body) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0b;color:#f5f5f7;font-family:system-ui,sans-serif">
<div style="text-align:center;padding:32px;border:1px solid #26262a;border-radius:14px;background:#101012;max-width:420px">${body}</div></body>`;

  app.get("/spotify", (_req, res) => {
    if (!configured()) return res.status(503).send(page("ECC00 Spotify", "<h2>Not set up yet</h2><p style=color:#86868c>The owner hasn't connected the Spotify app.</p>"));
    const state = crypto.randomBytes(12).toString("hex");
    states.set(state, Date.now() + 10 * 60_000);
    const q = new URLSearchParams({ client_id: process.env.SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: REDIRECT, scope: SCOPES, state });
    res.redirect("https://accounts.spotify.com/authorize?" + q);
  });

  app.get("/spotify/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.send(page("ECC00 Spotify", `<h2>Not connected</h2><p style=color:#86868c>Spotify said: ${String(error).replace(/[<>&"]/g, "")}</p>`));
    if (!state || !(states.get(state) > Date.now())) return res.status(400).send(page("ECC00 Spotify", "<h2>Link expired</h2><p style=color:#86868c>Open eccohub.xyz/spotify again.</p>"));
    states.delete(state);
    try {
      const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
      const me = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer " + t.access_token } }).then((r) => r.json());
      const premium = me.product === "premium";
      const token = seal({ r: t.refresh_token, p: premium, n: me.display_name || me.id });
      let six;
      do six = String(crypto.randomInt(0, 1e6)).padStart(6, "0"); while (codes.has(six));
      codes.set(six, { token, name: me.display_name || me.id, premium, exp: Date.now() + 10 * 60_000 });
      res.send(page("ECC00 Spotify", `<p style=color:#86868c;margin:0>Connected as <b style=color:#f5f5f7>${String(me.display_name || me.id).replace(/[<>&"]/g, "")}</b></p>
<p style=color:#86868c>Type this code into the Spotify tab in ECC00:</p>
<div style="font-size:44px;letter-spacing:10px;font-weight:700;margin:18px 0">${six}</div>
<p style=color:#86868c;font-size:13px>It works once, for 10 minutes.</p>`));
    } catch (e) {
      res.status(500).send(page("ECC00 Spotify", `<h2>Something went wrong</h2><p style=color:#86868c>${String(e.message).replace(/[<>&"]/g, "")}</p>`));
    }
  });

  app.post("/api/spotify/link", express.json({ limit: "1kb" }), (req, res) => {
    // 5 tries per 10 min per IP: a 6-digit code can't be guessed before it expires
    if (limited(req, "spotify-link", 5, 10 * 60_000)) return res.status(429).json({ ok: false, error: "Too many tries. Wait 10 minutes, then try again." });
    const code = String(req.body?.code || "").replace(/\D/g, "");
    const hit = codes.get(code);
    if (!hit || hit.exp < Date.now()) return res.json({ ok: false, error: "That code is wrong or expired. Get a new one at eccohub.xyz/spotify" });
    codes.delete(code);
    const device = String(req.body?.device || "");
    const data = open(hit.token);
    const token = device && data ? seal({ ...data, h: sha(device) }) : hit.token; // locked to this device
    res.json({ ok: true, token, name: hit.name, premium: hit.premium });
  });

  app.get("/api/spotify/now", async (req, res) => {
    try {
      const a = await accessFor(req.get("x-ecc00-token") || req.query.t, req.get("x-ecc00-device"));
      if (!a) return res.json({ ok: false, error: "relink" });
      const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", { headers: { Authorization: "Bearer " + a.at } });
      const base = { ok: true, premium: Boolean(a.data.p), name: a.data.n, token: a.newToken || undefined };
      if (r.status === 204) return res.json({ ...base, playing: false });
      if (r.status === 401) return res.json({ ok: false, error: "relink" });
      const j = await r.json();
      const it = j.item;
      if (!it) return res.json({ ...base, playing: false });
      const out = {
        ...base, playing: true, isPlaying: Boolean(j.is_playing), id: it.id, title: it.name,
        artist: (it.artists || []).map((x) => x.name).join(", "), album: it.album?.name,
        cover: (it.album?.images || []).find((i) => i.width <= 300)?.url || it.album?.images?.[0]?.url,
        progress: (j.progress_ms || 0) / 1000, duration: (it.duration_ms || 0) / 1000,
      };
      // lyrics + colour once per song; the script sends `have` with the song it already has
      if ((req.get("x-ecc00-have") ?? req.query.have) !== it.id) {
        let extra = tracks.get(it.id);
        if (!extra) {
          extra = { lyrics: [], color: null };
          const small = (it.album?.images || []).slice(-1)[0]?.url;
          await Promise.all([
            findLyrics(it).then((l) => Object.assign(extra, l)).catch(() => {}),
            small ? fetch(small).then((x) => x.arrayBuffer()).then((b) => { extra.color = coverColor(Buffer.from(b)); }).catch(() => {}) : null,
          ]);
          if (tracks.size > 500) tracks.clear(); // ponytail: crude bound, an LRU if memory ever matters
          tracks.set(it.id, extra);
        }
        Object.assign(out, extra);
      }
      res.json(out);
    } catch (e) {
      res.json({ ok: false, error: String(e.message).slice(0, 120) });
    }
  });

  app.post("/api/spotify/control", express.json({ limit: "2kb" }), async (req, res) => {
    const routes = { play: ["PUT", "play"], pause: ["PUT", "pause"], next: ["POST", "next"], prev: ["POST", "previous"] };
    const rt = routes[req.body?.action];
    if (!rt) return res.status(400).json({ ok: false });
    try {
      const a = await accessFor(req.body.t, req.body.device);
      if (!a) return res.json({ ok: false, error: "relink" });
      if (!a.data.p) return res.json({ ok: false, error: "Spotify Premium is needed for controls" });
      const r = await fetch("https://api.spotify.com/v1/me/player/" + rt[1], { method: rt[0], headers: { Authorization: "Bearer " + a.at } });
      res.json({ ok: r.ok || r.status === 204 });
    } catch (e) {
      res.json({ ok: false, error: String(e.message).slice(0, 120) });
    }
  });

  setInterval(() => { // drop expired one-time stuff
    const now = Date.now();
    for (const [k, v] of states) if (v < now) states.delete(k);
    for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
    for (const [k, v] of access) if (v.exp < now) access.delete(k);
  }, 60_000).unref();
};

module.exports._test = { seal, open, parseLrc, cleanTitle };
