export const meta = {
  purpose:
    "What was written or changed since a time, day by day, newest first: each note with whether it was created or changed and its size. A note's date comes from its front matter or file name, else from the file's time (marked). The answer to 'what did I write this week', 'what changed since Monday', 'what did I work on yesterday', 'which notes are new this month'.",
  params: {
    since: "from when: a date, 'today', 'yesterday', 'week' (since Monday), 'month', or a span back such as '7d', '2w'; default '7d'",
    until: "up to when, default today",
    created: "true for new notes only, default false",
    max: "notes returned, default 50",
    today: "the date to count from, default the machine's date",
    vault: "another notes folder, optional",
  },
  returns: "{verdict, since, until, days:[{day, weekday, notes:[{path, title, what, words, tags?, dateFrom?}]}], total, leftOut?, privateNotes?}",
  example: 'await scripts.run("recent", { since: "week" })',
};

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function ({ notes }, { since = "7d", until, created = false, max = 50, today, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  const r = v.recent({ since, until, created, max, today });
  const days = new Map();
  for (const { day, ...n } of r.notes) {
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(n);
  }
  const made = r.notes.filter((n) => n.what === "created").length;
  const fromFile = r.notes.filter((n) => n.dateFrom === "file time").length;
  const { notes: _list, ...rest } = r;
  const verdict = !r.total
    ? `nothing written or changed from ${r.since} to ${r.until}`
    : `${r.total} note${r.total === 1 ? "" : "s"} from ${r.since} to ${r.until}: ${made} created, ${r.notes.length - made} changed, on ${days.size} day${days.size === 1 ? "" : "s"}${r.leftOut ? " (of those listed)" : ""}${fromFile ? `; ${fromFile} dated by file time only` : ""}`;
  return { verdict, ...rest, days: [...days].map(([day, list]) => ({ day, weekday: DOW[new Date(`${day}T00:00:00Z`).getUTCDay()], notes: list })) };
}
