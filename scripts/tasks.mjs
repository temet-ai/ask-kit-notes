export const meta = {
  purpose:
    "The tasks in the notes: open ones by default, overdue first, then by due date, then undated; grouped by note or by due date. Reads `- [ ]` and `- [x]` with due dates (📅 2026-11-08, due:: 2026-11-08) and Logseq TODO and DONE. The answer to 'what are my open tasks', 'what is overdue', 'what is due this week', 'what is left on WATCH-12', 'what did I finish'.",
  params: {
    state: "'open' (default), 'done' or 'all'",
    due: "'overdue', 'today', 'week' (due within 7 days, overdue included), 'none' (undated), or a date: due on or before it; optional",
    tag: "only tasks with this tag, or in a note with it, optional",
    note: "only one note's tasks: a title, alias, file name or path, optional",
    by: "'due' (default) or 'note': how the tasks are grouped",
    max: "tasks returned, default 60",
    today: "the date overdue is counted from, default the machine's date",
    vault: "another notes folder, optional",
  },
  returns: "{verdict, today, groups:[{group, tasks:[{path, line, text, done, due?, overdue?, heading, tags?}]}], total, open, overdue, done, leftOut?, note?, matchedBy?}",
  example: 'await scripts.run("tasks", { due: "week" })',
};

export default async function ({ notes }, { state = "open", due, tag, note, by = "due", max = 60, today, vault } = {}) {
  const v = vault ? notes.at(vault) : notes;
  if (!["open", "done", "all"].includes(state)) throw new Error(`tasks: state is 'open', 'done' or 'all', not '${state}'`);
  const r = v.tasks({ open: state === "all" ? undefined : state === "open", due, tag, note, max, today });
  if (r.found === false) return { verdict: `no note "${note}"${r.near?.length ? `; near: ${r.near.join(", ")}` : ""}`, ...r };
  if (r.private) return { verdict: `"${r.title}" is private: its tasks are not read`, ...r };
  const groups = new Map();
  const week = new Date(`${r.today}T00:00:00Z`);
  week.setUTCDate(week.getUTCDate() + 7);
  const soon = week.toISOString().slice(0, 10);
  for (const t of r.tasks) {
    const g = by === "note" ? t.path : t.done ? "done" : t.cancelled ? "cancelled" : t.overdue ? "overdue" : !t.due ? "no due date" : t.due === r.today ? "due today" : t.due <= soon ? "due within 7 days" : "due later";
    const { noteDate, ...row } = t;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(by === "note" ? (({ path, ...rest }) => rest)(row) : row);
  }
  const { tasks, ...rest } = r;
  const where = note ? ` in ${r.note.path}` : "";
  const verdict =
    state === "done"
      ? `${r.done} done task${r.done === 1 ? "" : "s"}${where}`
      : !r.open
        ? `no open task${where}${due ? ` with due ${typeof due === "string" ? due : "in that range"}` : ""}${tag ? ` tagged ${tag}` : ""}`
        : `${r.open} open task${r.open === 1 ? "" : "s"}${where}: ${r.overdue} overdue${r.overdue ? ` (oldest due ${tasks.find((t) => t.overdue).due})` : ""}, ${tasks.filter((t) => !t.done && !t.cancelled && !t.due).length} with no due date${r.leftOut ? "; counts cover all, the list is cut" : ""}`;
  return { verdict, ...rest, groups: [...groups].map(([group, list]) => ({ group, tasks: list })) };
}
