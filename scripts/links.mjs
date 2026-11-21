export const meta = {
  purpose:
    "One note's place among the others: the notes that link to it (backlinks) and what it links to, each with the line the link sits on, and its links to notes that do not exist. Reads [[wiki links]], ![[embeds]] and Markdown links. The answer to 'what links to X', 'what mentions X', 'what does X link to', 'which links in X are broken'.",
  params: {
    note: "the note: a title, alias, file name or path, e.g. 'WATCH-12'",
    max: "links returned each way, default 40",
    vault: "another notes folder, optional",
  },
  returns: "{verdict, note:{path, title, date}, matchedBy, backlinks:[{path, title, date, line, heading, embed?, text}], links:[{line, target, resolved, heading?, shownAs?, embed?, text}], unresolved:[target], fromPrivateNotes?}",
  example: 'await scripts.run("links", { note: "Sam Vimes" })',
};

export default async function ({ notes }, { note, name, max = 40, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  const which = note ?? name;
  if (!which) throw new Error("links needs `note`: a title, alias, file name or path");
  const back = v.backlinks(which, { max });
  if (!back.found) return { verdict: `no note "${which}"${back.near?.length ? `; near: ${back.near.join(", ")}` : ""}`, ...back };
  if (back.private) return { verdict: `"${back.title}" is private: its links are not read`, ...back };
  const out = v.links(back.note.path, { max });
  const from = new Set(back.backlinks.map((b) => b.path)).size;
  const verdict = `${back.note.path} (matched by ${back.matchedBy}): ${back.total} link${back.total === 1 ? "" : "s"} in from ${from} note${from === 1 ? "" : "s"}${back.fromPrivateNotes ? ` and ${back.fromPrivateNotes.length} private`: ""}, ${out.total} out, ${out.unresolved.length} to notes that do not exist${out.unresolved.length ? ` (${out.unresolved.join(", ")})` : ""}`;
  return {
    verdict,
    note: back.note,
    matchedBy: back.matchedBy,
    backlinks: back.backlinks,
    ...(back.leftOut ? { backlinksLeftOut: back.leftOut } : {}),
    ...(back.fromPrivateNotes ? { fromPrivateNotes: back.fromPrivateNotes } : {}),
    links: out.links,
    ...(out.leftOut ? { linksLeftOut: out.leftOut } : {}),
    unresolved: out.unresolved,
  };
}
