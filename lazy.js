// Answer an interaction in one direct reply when the work takes under 2s, and only fall back to "thinking" +
// edit when it's slower. Edits go through Discord's webhook route, which is limited by IP (Render's is shared)
// and was holding every reply forever; direct replies aren't affected.
module.exports = (i) => {
  if (!i.deferReply) return i;
  const defer = i.deferReply.bind(i), edit = i.editReply.bind(i), send = i.reply.bind(i);
  let opts = null, timer = null, real = null;
  i.deferReply = async (o = {}) => {
    opts = o;
    timer = setTimeout(() => { real = defer(o); real.catch((e) => console.error("defer:", e.message)); }, 2000);
  };
  const answer = async (body) => {
    clearTimeout(timer);
    if (real) { await real; return edit(body); }
    if (!opts) return edit(body);
    const o = opts;
    opts = null;
    return send({ ...(typeof body === "string" ? { content: body } : body), ...o });
  };
  i.editReply = answer;
  i.reply = (body) => (opts || real ? answer(body) : send(body));
  return i;
};
