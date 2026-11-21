export const meta = {
  purpose:
    "What the notes say about something: the notes that hold the words, best first (a title or alias match, then a heading, then the text; rare words weigh more; newest first within equal rank), each with its date and the passages. The answer to 'what did I write about X', 'where are my notes on X', 'when did I write about X'.",
  params: {
    words: "two to five distinctive words, e.g. 'clacks ledger'",
    tag: "only notes with this tag, optional",
    in: "only notes in this folder of the vault, optional",
    since: "only notes dated on or after this: a date, 'week', 'month', '30d', optional",
    until: "only notes dated on or before this, optional",
    max: "notes returned, default 8",
    today: "the date to count from, default the machine's date",
    vault: "another notes folder, optional",
  },
  returns: "{verdict, words, notes:[{path, title, date, score, matched:[title|heading|body], missing?, tags?, passages:[{line, heading, text}]}], total, leftOut?, searched}",
  example: 'await scripts.run("find", { words: "clacks ledger" })',
};

export default async function ({ notes }, { words, topic, tag, in: folder, since, until, max = 8, today, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  const text = words ?? topic;
  if (!text) throw new Error("find needs `words`: what to look for, e.g. { words: 'clacks ledger' }");
  const r = v.find(text, { tag, in: folder, since, until, max, today });
  const top = r.notes[0];
  const verdict = !r.total
    ? `no note holds ${r.words.join(" or ")} (${r.searched} notes searched)`
    : `${r.total} of ${r.searched} notes hold ${r.words.join(", ")}; best: ${top.path} (${top.date})${top.missing ? `, which lacks ${top.missing.join(", ")}` : ""}`;
  return { verdict, ...r };
}
