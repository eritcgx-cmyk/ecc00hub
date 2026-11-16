// Verba AI chat: the bot answers when someone @mentions it or replies to it.
// Verba keeps the conversation server-side per session_id, so we only send the newest message.
// Needs VERBA_API_KEY (Pro/Ultra plan) and VERBA_CHARACTER (the Verb's slug) on Render.
const { VERBA_API_KEY, VERBA_CHARACTER } = process.env;
const last = new Map(); // userId -> ms of last ask
// ponytail: in-memory 5s cooldown per user, resets on restart; fine for one instance.

async function ask(userId, text) {
  const r = await fetch("https://api.verba.ink/v1/response", {
    method: "POST",
    headers: { Authorization: `Bearer ${VERBA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      character: VERBA_CHARACTER,
      session_id: `discord-${userId}`, // one conversation per person
      messages: [{ role: "user", content: text.slice(0, 4000) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.error?.message || ""}`.trim());
  return j.choices?.[0]?.message?.content || "...";
}

async function onMessage(m, client, skipChannel) {
  if (!VERBA_API_KEY || !VERBA_CHARACTER || m.author.bot || !m.guild || m.channelId === skipChannel) return;
  const mentioned = m.mentions.users.has(client.user.id);
  const repliedToBot = m.mentions.repliedUser?.id === client.user.id;
  if (!mentioned && !repliedToBot) return;
  const text = m.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  if (!text) return;
  if (Date.now() - (last.get(m.author.id) || 0) < 5000) return m.react("⏳").catch(() => {});
  last.set(m.author.id, Date.now());
  await m.channel.sendTyping().catch(() => {});
  let out;
  try { out = await ask(m.author.id, text); }
  catch (e) { console.error("verba:", e.message); out = e.message.startsWith("429") ? "I'm getting too many messages, try again in a bit." : "I couldn't answer that right now."; }
  return m.reply({ content: out.slice(0, 2000), allowedMentions: { parse: [], repliedUser: true } });
}

module.exports = { onMessage, ask };
