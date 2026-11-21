export const meta = {
  purpose:
    "A day's daily note with its text and tasks, or, with `since`, the daily notes of a range (each day's headings, links and task counts, without the text). The answer to 'what is in today's daily note', 'what did I note yesterday', 'what did I do on 6 November', 'which days did I journal last week'.",
  params: {
    date: "the day: a date (2026-11-08), 'today' (default) or 'yesterday'",
    since: "for a range instead of one day: a date, 'week', 'month', '14d'",
    until: "end of the range, default today",
    today: "the date to count from, default the machine's date",
    vault: "another notes folder, optional",
  },
  returns: "one day: {verdict, date, weekday, exists, path, words, tasks:[{line, text, done, due?}], links, lines, text} or {exists:false, expectedAt, nearest:{before, after}}; a range: {verdict, since, until, pattern, days:[{date, weekday, path, words, headings, tasksOpen, tasksDone, links}], total}",
  example: 'await scripts.run("daily", { date: "yesterday" })',
};

export default async function ({ notes }, { date, since, until, today, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  if (since) {
    const r = v.dailies({ since, until, today });
    return { verdict: r.total ? `${r.total} daily note${r.total === 1 ? "" : "s"} from ${r.since} to ${r.until} (${r.days[0].date} to ${r.days.at(-1).date})` : `no daily note from ${r.since} to ${r.until}; daily notes are expected at ${r.pattern}`, ...r };
  }
  const r = v.daily(date ?? "today", { today });
  const open = r.exists && !r.private ? r.tasks.filter((t) => !t.done).length : 0;
  const verdict = r.private
    ? `the daily note of ${r.date} is private: it is not read`
    : r.exists
      ? `${r.path} (${r.weekday}): ${r.words} words, ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"}, ${open} open`
      : `no daily note for ${r.date} (${r.weekday}); it would be ${r.expectedAt}${r.nearest.before ? `; the last one before it is ${r.nearest.before}` : ""}`;
  return { verdict, ...r };
}
