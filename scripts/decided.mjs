export const meta = {
  purpose:
    "What was decided and why: decisions found in the notes (a 'Decision' or 'Outcome' heading, a line saying 'decided', 'we will', 'agreed', 'going with', and decision records such as ADR files), each with its note, date, line and the reason lines near it; decisions on the topic's own lines first, newest first. The answer to 'what did I decide about X and why', 'is there a decision on X', 'list the decisions'.",
  params: {
    topic: "words the decision is about, e.g. 'night patrols'; every decision when omitted",
    tag: "only notes with this tag, optional",
    in: "only notes in this folder, optional",
    since: "only notes dated on or after this, optional",
    until: "only notes dated on or before this, optional",
    max: "decisions returned, default 10",
    today: "the date to count from, default the machine's date",
    vault: "another notes folder, optional",
  },
  returns: "{verdict, topic, decisions:[{path, title, date, status?, line, heading, decision, reasons:[{line, text, under?}], topicIsIn?}], total, leftOut?, searched}",
  example: 'await scripts.run("decided", { topic: "night patrols" })',
};

export default async function ({ notes }, { topic, words, tag, in: folder, since, until, max = 10, today, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  const r = v.decisions(topic ?? words ?? "", { tag, in: folder, since, until, max, today });
  const about = r.topic.length ? ` on ${r.topic.join(" ")}` : "";
  const d = r.decisions[0];
  const reasoned = d && (d.reasons.length || /\b(because|since|so that|in order to|due to)\b/i.test(d.decision));
  const verdict = !r.total
    ? `no decision${about} found in ${r.searched} notes: no decision heading, decision words or decision record holds the topic`
    : `${r.total} decision${r.total === 1 ? "" : "s"}${about}; ${r.topic.length ? "best" : "newest"}: ${d.path}:${d.line} (${d.date})${reasoned ? "" : ", with no reason written near it"}`;
  return { verdict, ...r };
}
