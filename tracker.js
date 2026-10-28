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
    channels.size ? exploits().catch(() => null) : null,
    robloxVersion().catch(() => null),
  ]);
  if (versions?.Windows) latest.roblox = versions.Windows;

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
      } else if (list) {
        const ex = list.find((e) => e.title.toLowerCase() === target.toLowerCase());
        if (!ex) continue;
        await setDot(ch, ex.updateStatus ? "up" : "down");
        // new executor version: post it in its status channel (the first sighting only records it)
        if (ex.version && ex.version !== seen) {
          if (seen) {
            const at = Date.parse(String(ex.updatedDate || "").replace(" at ", " ")) || Date.now();
            await ch.send({ embeds: [releaseEmbed(brand, {
              title: `${ex.title} Update`, from: seen, to: ex.version, roblox: ex.rbxversion, at,
              rows: [
                ["+", `Updated to ${ex.rbxversion || "the latest Roblox"}`],
                ex.updateStatus ? ["*", "Working on the current Roblox version"] : ["!", "Not updated for the current Roblox yet"],
              ],
            })] });
          }
          await ch.setTopic(`weao:${ex.title} ${ex.version}`);
        }
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
