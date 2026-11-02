// Status channels driven by WEAO (whatexpsare.online, docs.weao.xyz). A channel opts in through its topic,
// so there is nothing to store: "weao:Volt" tracks an executor, "weao:roblox" posts Roblox updates,
// "weao:ecc00" watches our own hub. Only the dot in the channel name changes: ╠➣〢🟢〢Volt-Status.
const { ChannelType, EmbedBuilder } = require("discord.js");

const WEAO = "https://weao.xyz/api";
const HEADERS = { "User-Agent": "WEAO-3PService" }; // WEAO rejects any other user agent
const DOTS = { up: "\u{1F7E2}", issues: "\u{1F7E1}", down: "\u{1F534}" };
const ANY_DOT = new RegExp(Object.values(DOTS).join("|"), "u");
const TAG = /weao:(\S+)(?:\s+(\S+))?/i; // "weao:<source> <last version seen>"

const latest = { roblox: null }; // last seen Roblox version, for the bot's rotating status

const getJson = (url) => fetch(url, { headers: HEADERS }).then((r) => {
  if (!r.ok) throw new Error(`WEAO ${r.status}`);
  return r.json();
});
const exploits = () => getJson(`${WEAO}/status/exploits`);
const robloxVersion = () => getJson(`${WEAO}/versions/current`);

async function ecc00State() {
  try {
    const cfg = await fetch("https://eccohub.xyz/config.json", { headers: { "User-Agent": "Roblox/WinInet" } }).then((r) => r.json());
    return cfg.status === "shutdown" ? "down" : "up";
  } catch { return "down"; }
}

// The release-post look shared by /update and the trackers:
//   Version: a -> b / Roblox Version / Released: <date> / <ago>, then a coloured changelog.
// rows = [["+", "Added x"], ["*", "Improved y"], ["!", "Fixed z"], ["-", "Removed w"]]
const ANSI = { "+": 32, "*": 34, "!": 33, "-": 31 };
const ESC = String.fromCharCode(27);
const changelog = (rows) => "```ansi\n" + rows.map(([m, t]) => `${ESC}[2;${ANSI[m]}m[${m}]${ESC}[0m ${t}`).join("\n") + "\n```";
function releaseEmbed(brand, { title, from, to, roblox, at = Date.now(), rows, extra = [] }) {
  const unix = Math.floor(at / 1000);
  const head = [
    to && `**Version:** ${from && from !== to ? `${from} -> ${to}` : to}`,
    roblox && `**Roblox Version:** ${roblox}`,
    `**Released:** <t:${unix}:F> / <t:${unix}:R>`,
  ].filter(Boolean).join("\n");
  const e = brand(new EmbedBuilder()).setTitle(title).setDescription(head);
  if (rows.length) e.addFields({ name: "Changelog", value: changelog(rows).slice(0, 1024) });
  for (const [name, r] of extra) if (r.length) e.addFields({ name, value: changelog(r).slice(0, 1024) });
  return e;
}

// ---------------------------------------------------------------- executor changes
// WEAO has no changelogs, so an "update" post lists exactly which of these moved since the last check.
// ponytail: snapshots live in memory; a bot restart skips one round of diffs instead of re-posting everything
const snaps = new Map();
const snapOf = (e) => ({ version: e.version, rbx: e.rbxversion, ok: e.updateStatus, sunc: e.suncPercentage, unc: e.uncPercentage, detected: e.detected, issues: e.hasIssues });
function diffRows(p, e) {
  const n = snapOf(e), rows = [];
  if (n.version !== p.version) rows.push(["+", `Version ${p.version || "?"} -> ${n.version}`]);
  if (n.rbx !== p.rbx) rows.push(["+", `Now built for ${n.rbx || "a new Roblox version"}`]);
  if (n.ok !== p.ok) rows.push(n.ok ? ["*", "Working on the current Roblox again"] : ["!", "Not working on the current Roblox (needs an update)"]);
  if (n.sunc !== p.sunc && n.sunc != null) rows.push([n.sunc > (p.sunc || 0) ? "*" : "-", `sUNC ${p.sunc ?? "?"}% -> ${n.sunc}%`]);
  if (n.unc !== p.unc && n.unc != null) rows.push([n.unc > (p.unc || 0) ? "*" : "-", `UNC ${p.unc ?? "?"}% -> ${n.unc}%`]);
  if (n.detected !== p.detected) rows.push(n.detected ? ["!", "Now flagged as detected"] : ["*", "No longer detected"]);
  if (n.issues !== p.issues) rows.push(n.issues ? ["!", "Has reported issues"] : ["*", "Reported issues fixed"]);
  return rows;
}
// WEAO keeps per-executor changelogs (markdown) for executors whose own API publishes them.
// "## New/Improved/Fixed/Removed" sections become [+]/[*]/[!]/[-]; "### Title" and "- item" lines become rows.
const SECTION = [[/fix|bug/i, "!"], [/improv|chang|updat/i, "*"], [/remov|delet/i, "-"], [/./, "+"]];
function parseChangelog(md) {
  const rows = [];
  let mark = "+";
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim(); // some changelogs come ANSI-coloured
    if (!line) continue;
    const tagged = line.match(/^\[([+*!-])\]\s*(.+)/); // "[+] Added x" style (Isaeva and others)
    if (tagged) { rows.push([tagged[1], tagged[2].slice(0, 120)]); continue; }
    const h2 = line.match(/^##\s+(.+)/);
    if (h2 && !line.startsWith("###")) { mark = SECTION.find(([re]) => re.test(h2[1]))[1]; continue; }
    const item = line.match(/^(?:###\s+|[-*]\s+)(.+)/);
    if (item) rows.push([mark, item[1].replace(/\*\*/g, "").slice(0, 120)]);
  }
  return rows.slice(0, 15);
}
async function changelogRows(ex) {
  try {
    const d = await getJson(`${WEAO}/status/exploits/changelogs/${encodeURIComponent(ex.title)}`);
    const list = Array.isArray(d.changelogs) ? d.changelogs : [];
    const entry = list.find((c) => c.version === ex.version) || list[list.length - 1];
    return entry ? parseChangelog(entry.changelog) : [];
  } catch { return []; }
}
function executorEmbed(brand, e, rows) {
  const at = Date.parse(String(e.updatedDate || "").replace(" at ", " ")) || Date.now();
  const status = [e.updateStatus ? "Working" : "Down", e.suncPercentage != null && `sUNC ${e.suncPercentage}%`, e.uncPercentage != null && `UNC ${e.uncPercentage}%`,
    e.free ? "Free" : (e.cost || "Paid"), e.detected && "Detected"].filter(Boolean).join("  |  ");
  return releaseEmbed(brand, { title: `${e.title} Update`, to: e.version, roblox: e.rbxversion, at, rows })
    .addFields({ name: "Status", value: status.slice(0, 1024) });
}

// Rename only when the dot actually changes: Discord allows 2 channel renames per 10 minutes.
async function setDot(ch, state) {
  if (!ANY_DOT.test(ch.name)) return false;
  const name = ch.name.replace(ANY_DOT, DOTS[state]);
  if (name === ch.name) return false;
  await ch.setName(name);
  return true;
}

async function tick(client, brand) {
  const channels = client.channels.cache.filter((c) => c.type === ChannelType.GuildText && TAG.test(c.topic || ""));
  const [list, versions] = await Promise.all([
    exploits().catch(() => null), // always: the snapshots need every tick
    robloxVersion().catch(() => null),
  ]);
  if (versions?.Windows) latest.roblox = versions.Windows;
  // what changed per executor since the last tick (first sighting after a restart only records)
  const changed = [];
  for (const ex of list || []) {
    const prev = snaps.get(ex.title);
    let rows = prev ? diffRows(prev, ex) : [];
    // a new version: lead with the executor's own changelog from WEAO (when WEAO has one for it)
    if (prev && ex.version !== prev.version) rows = [...await changelogRows(ex), ...rows];
    if (rows.length) changed.push({ ex, rows });
    snaps.set(ex.title, snapOf(ex));
  }

  for (const ch of channels.values()) {
    const [, target, seen] = ch.topic.match(TAG);
    try {
      if (target.toLowerCase() === "roblox") {
        if (!versions?.Windows || versions.Windows === seen) continue;
        // First sighting just records the version; only real changes get announced.
        if (seen) {
          const at = (versions.WindowsResponse?.timestamp || 0) * 1000 || Date.now();
          await ch.send({ content: "@everyone", allowedMentions: { parse: ["everyone"] }, embeds: [releaseEmbed(brand, {
            title: "Roblox Update", from: seen, to: versions.Windows, at,
            rows: [["+", `Updated to ${versions.Windows}`], ["!", "Executors need to update before they work again"]],
          })] });
        }
        await ch.setTopic(`weao:roblox ${versions.Windows}`);
      } else if (target.toLowerCase() === "ecc00") {
        await setDot(ch, await ecc00State());
      } else if (target.toLowerCase() === "pc") {
        // every Windows executor on WEAO, one post per executor that changed since the last check
        for (const { ex, rows } of changed) {
          if (String(ex.platform).toLowerCase() === "windows") await ch.send({ embeds: [executorEmbed(brand, ex, rows)] });
        }
      } else if (list) {
        const ex = list.find((e) => e.title.toLowerCase() === target.toLowerCase());
        if (!ex) continue;
        await setDot(ch, ex.updateStatus ? "up" : "down");
        const hit = changed.find((c) => c.ex === ex);
        if (hit) await ch.send({ embeds: [executorEmbed(brand, ex, hit.rows)] });
      }
    } catch (e) {
      console.error(`tracker ${ch.name}:`, e.message);
    }
  }
}

function start(client, brand) {
  const run = () => tick(client, brand).catch((e) => console.error("tracker:", e.message));
  run();
  setInterval(run, 2 * 60_000); // WEAO asks callers to keep the interval modest
}

module.exports = { start, tick, setDot, exploits, robloxVersion, releaseEmbed, latest, DOTS, ANY_DOT };
