export const meta = {
  purpose:
    "The vault at a glance: how many notes and words, the date range, the most used tags, tasks open, overdue and done, the most linked notes, notes nothing links to, links to notes that do not exist, where daily notes live, and what is left out (private notes by title, attachments, credential-named files). The answer to 'what is in my notes', 'how big is the vault', 'which notes are orphans', 'which links are broken'.",
  params: {
    max: "entries per list, default 10",
    today: "the date overdue is counted from, default the machine's date",
    vault: "another notes folder, optional",
  },
  returns: "{verdict, root, notes, words, oldest, newest, tags:{total, top}, tasks:{open, overdue, done, cancelled}, links, mostLinked:[{path, title, linkedFrom}], orphans:{total, notes}, unresolved:{total, links:[{target, count, from}]}, dailyNotes, private, leftOut, index}",
  example: 'await scripts.run("overview")',
};

export default async function ({ notes }, { max = 10, today, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  const i = v.index();
  const tags = v.tags({ max });
  const orphans = v.orphans({ max });
  const unresolved = v.unresolved({ max });
  const t = v.tasks({ open: true, today, max: 1 });
  const verdict = `${i.notes} notes, ${i.words} words, ${i.oldest ?? "?"} to ${i.newest ?? "?"}; ${t.open} open tasks (${t.overdue} overdue), ${i.tasks.done} done; ${orphans.total} orphans, ${unresolved.total} links to notes that do not exist; ${i.private.count} private`;
  return {
    verdict,
    root: i.root,
    notes: i.notes,
    words: i.words,
    oldest: i.oldest,
    newest: i.newest,
    tags: { total: tags.total, top: tags.tags },
    tasks: { open: t.open, overdue: t.overdue, done: i.tasks.done, cancelled: i.tasks.cancelled },
    links: i.links,
    mostLinked: v.hubs({ max }),
    orphans: { total: orphans.total, notes: orphans.orphans.map((n) => ({ path: n.path, date: n.date, linksOut: n.linksOut })) },
    unresolved: { total: unresolved.total, links: unresolved.unresolved },
    dailyNotes: i.dailyNotes,
    private: i.private,
    leftOut: i.leftOut,
    index: i.index,
  };
}
