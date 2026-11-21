export const meta = {
  purpose:
    "The tags of the vault with the number of notes carrying each (front matter tags and #tags in the text; a nested tag a/b also counts for a), or, with `tag`, the notes that carry that tag, newest first. The answer to 'which tags do I use', 'which notes are tagged X', 'which cases are open' when a tag says so.",
  params: {
    tag: "a tag, with or without #, e.g. 'case/open'; all tags when omitted",
    max: "tags or notes returned, default 60",
    vault: "another notes folder, optional",
  },
  returns: "all tags: {verdict, tags:[{tag, notes}], total, leftOut?}; one tag: {verdict, tag, notes:[{path, title, date, tags}], total, leftOut?, privateNotes?, near?}",
  example: 'await scripts.run("tags", { tag: "case/open" })',
};

export default async function ({ notes }, { tag, max = 60, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  if (!tag) {
    const r = v.tags({ max });
    return { verdict: r.total ? `${r.total} tags; most used: ${r.tags.slice(0, 5).map((t) => `${t.tag} (${t.notes})`).join(", ")}` : "the notes carry no tags", ...r };
  }
  const r = v.tagged(tag, { max });
  const verdict = r.total
    ? `${r.total} note${r.total === 1 ? "" : "s"} tagged ${r.tag}${r.privateNotes ? `, and ${r.privateNotes} private` : ""}; newest: ${r.notes[0].path} (${r.notes[0].date})`
    : `no note is tagged ${r.tag}${r.near?.length ? `; near: ${r.near.join(", ")}` : ""}`;
  return { verdict, ...r };
}
