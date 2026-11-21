// Dates are YYYY-MM-DD strings in local time. `name` is a note's title, alias, file name or path
// (any case; a part of a name matches when nothing matches exactly). Lines are 1-based. Every line
// of text returned has passwords, tokens and keys replaced by [redacted]. Private notes (front
// matter `private: true`, or a tag in NOTES_PRIVATE_TAGS) come back as `{ private: true, title }`
// and are never searched, quoted or edited. Files named like credentials, hidden folders and
// attachments are not in the vault at all.
// A time is a date, "today", "yesterday", "week" (since Monday), "month", "year", or a span back
// such as "7d", "2w", "3m". `today` in any option overrides the machine's date.

interface Row { path: string; title: string; date: string; dateFrom?: "file time" } // date: front matter, else file name, else file time

interface Filter {
  tag?: string;            // only notes with this tag (a nested tag a/b matches a)
  in?: string;             // only notes in this folder
  since?: string;          // only notes dated on or after this
  until?: string;          // only notes dated on or before this
  today?: string;
}

declare const notes: {
  // The folder this vault reads.
  root: string;

  // The vault in numbers and what was left out: notes, words, tags, links, links to notes that do not
  // exist, tasks {open, done, cancelled}, dailyNotes {pattern, from, count}, oldest and newest date,
  // private {count, titles}, leftOut {attachments, credentialNamed, hiddenFolders, tooBig}, index.
  index(): { root: string; notes: number; words: number; tags: number; links: number; unresolvedLinks: number; tasks: { open: number; done: number; cancelled: number }; dailyNotes: { pattern: string; from: string; count: number }; oldest: string | null; newest: string | null; private: { count: number; titles: string[]; why: string }; leftOut: { attachments: number; credentialNamed: number; hiddenFolders: string[]; tooBig: string[]; beyondLimit?: string }; index: { file: string; read: number; reused: number; ms: number } };

  // Notes about some words, best first: a title or alias match, then a heading, then the text; rare
  // words weigh more. Each carries up to three passages. `missing` lists the words a note lacks.
  // Use it for "what did I write about X". Words are matched at the start of a word.
  find(words: string, o?: Filter & { max?: number }): { words: string[]; notes: (Row & { score: number; matched: ("title" | "heading" | "body")[]; missing?: string[]; tags?: string[]; passages: { line: number; heading: string | null; text: string }[] })[]; total: number; leftOut?: number; searched: number; privateNotesWithTheWordInTheirTitle?: string[] };

  // Lines that match a regular expression (case-insensitive unless ignoreCase is false). Use it for
  // an exact phrase or a pattern; use find for words.
  grep(pattern: string | RegExp, o?: Filter & { max?: number; ignoreCase?: boolean }): { hits: (Row & { line: number; heading: string | null; text: string })[]; total: number; complete: boolean; searched: number };

  // One note with its text as "line<TAB>text" rows. heading: only that section; from, to, max: a range
  // of lines (default the first 200). `more` says how to read on. found: false carries `near`.
  note(name: string, o?: { heading?: string; from?: number; to?: number; max?: number }): { found: boolean; path?: string; title?: string; matchedBy?: "path" | "file name" | "title" | "alias" | "substring"; alsoMatched?: string[]; date?: string; dateFrom?: string; modified?: string; aliases?: string[]; tags?: string[]; properties?: Record<string, string>; words?: number; headings?: { line: number; level: number; text: string }[]; tasks?: { open: number; done: number }; links?: { out: number; in: number }; section?: string; lines?: number; from?: number; to?: number; more?: string; clipped?: boolean; text?: string; private?: boolean; near?: string[]; error?: string };

  // The notes that link to a note ([[wiki links]], ![[embeds]], Markdown links), each with the line.
  backlinks(name: string, o?: { max?: number }): { found: boolean; note?: Row; matchedBy?: string; backlinks?: (Row & { line: number; heading: string | null; embed?: true; text: string })[]; total?: number; leftOut?: number; fromPrivateNotes?: string[]; private?: boolean; near?: string[] };

  // What a note links to. `resolved` is the target's path, or null when no such note exists (a broken link).
  links(name: string, o?: { max?: number }): { found: boolean; note?: Row; links?: { line: number; target: string; resolved: string | null; heading?: string; shownAs?: string; embed?: true; text: string }[]; total?: number; unresolved?: string[]; leftOut?: number; private?: boolean; near?: string[] };

  // Every tag with its number of notes. A nested tag a/b also counts for a.
  tags(o?: { max?: number }): { tags: { tag: string; notes: number }[]; total: number; leftOut?: number };

  // The notes with a tag (or a tag nested under it), newest first. `near` lists similar tags when none match.
  tagged(tag: string, o?: { max?: number }): { tag: string; notes: (Row & { tags: string[] })[]; total: number; leftOut?: number; privateNotes?: number; near?: string[] };

  // Tasks: "- [ ]", "- [x]", "- [-]" and Logseq TODO, DOING, DONE, with a due date from "📅 2026-11-08",
  // "due:: 2026-11-08", "@due(...)", or a DEADLINE line. open: true for open only, false for done only,
  // omitted for all. due: "overdue", "today", "week" (within 7 days, overdue included), "none",
  // "dated", a date (due on or before it) or { after, before }. note: one note's tasks. tag: tasks
  // tagged on their line or in a note with the tag. Overdue first, then by due date, then undated.
  // total, open, overdue and done count every match; `tasks` is cut at max.
  tasks(o?: { open?: boolean; due?: string | { after?: string; before?: string }; tag?: string; note?: string; max?: number; today?: string }): { today: string; note?: Row; matchedBy?: string; tasks: { path: string; line: number; text: string; done: boolean; cancelled?: true; due?: string; overdue?: true; scheduled?: string; doneOn?: string; tags?: string[]; heading: string | null; noteDate: string }[]; total: number; open: number; overdue: number; done: number; leftOut?: number; found?: false; private?: true };

  // Notes created or changed in a window, newest first. created: true for new notes only.
  recent(o?: { since?: string; until?: string; created?: boolean; max?: number; today?: string }): { since: string; until: string; notes: { path: string; title: string; day: string; what: "created" | "changed"; created?: string; dateFrom?: "file time"; words: number; tags?: string[] }[]; total: number; leftOut?: number; privateNotes?: number };

  // A day's daily note with its text, tasks and links. date: a date, "today" or "yesterday".
  // exists: false carries where it would be (`expectedAt`) and the nearest days that have one.
  // Where daily notes live comes from NOTES_DAILY, .obsidian/daily-notes.json, a Logseq journals
  // folder, or notes named like dates.
  daily(date?: string, o?: { max?: number; today?: string }): { date: string; weekday: string; exists: boolean; path?: string; words?: number; tags?: string[]; tasks?: { line: number; text: string; done: boolean; due?: string }[]; links?: string[]; lines?: number; more?: string; text?: string; private?: boolean; expectedAt?: string; pattern?: string; patternFrom?: string; nearest?: { before: string | null; after: string | null } };

  // The daily notes in a range, oldest first, without their text.
  dailies(o?: { since?: string; until?: string; max?: number; today?: string }): { since: string; until: string; pattern: string; days: ({ date: string; weekday: string; path: string; words: number; headings: string[]; tasksOpen: number; tasksDone: number; links: string[] } | { date: string; private: true })[]; total: number; leftOut?: number };

  // Links to notes that do not exist, most wanted first, with where they are.
  unresolved(o?: { max?: number }): { unresolved: { target: string; count: number; from: { path: string; line: number }[] }[]; total: number; leftOut?: number };

  // Notes nothing links to (daily notes left out), newest first.
  orphans(o?: { max?: number }): { orphans: (Row & { linksOut: number })[]; total: number; leftOut?: number };

  // The notes linked to from the most other notes.
  hubs(o?: { max?: number }): { path: string; title: string; linkedFrom: number }[];

  // Decisions: "Decision" or "Outcome" headings, lines that say "decided", "we will", "agreed", "going
  // with", and decision records (ADR files or a decisions folder), each with the reason lines near
  // it. With a topic, every word must be in the note; decisions on the topic's own lines come first.
  decisions(topic?: string, o?: Filter & { max?: number }): { topic: string[]; decisions: { path: string; title: string; date: string; dateFrom?: "file time"; status?: string; line: number; heading: string | null; decision: string; reasons: { line: number; text: string; under?: string }[]; topicIsIn?: string }[]; total: number; leftOut?: number; searched: number };

  // The same functions over another notes folder (relative to the folder the agent runs in).
  at(folder: string): typeof notes;

  // Changing notes. Each throws "not in this ask: ..." unless the caller asked for a change. A change
  // touches only the lines it adds or ticks; line endings, front matter and the rest stay as they are.
  // Each returns { changed, path, line, now } where `now` is the lines as they are after the change.
  // A private note, or one named like a credential file, is refused.

  // Add text at the end of a note, or under a heading (the heading is made at the end when absent).
  append(name: string, text: string, o?: { under?: string }): { changed: true; path: string; line: number; under: string | null; headingMade: boolean; added: number; now: string };
  // Make a new note; folder and tags are optional. Never overwrites: an existing note is refused.
  create(name: string, text?: string, o?: { folder?: string; tags?: string | string[] }): { changed: true; created: true; path: string; lines: number; tags?: string[]; sameNameAs?: string[]; note?: string };
  // Add an open task in the note's own style (a Markdown checkbox, or a Logseq TODO), under its Tasks heading when it has one.
  task(name: string, text: string, o?: { due?: string; under?: string; today?: string }): { changed: true; path: string; line: number; task: string; added: number; now: string };
  // Tick one open task by its line number or by words from its text. Several matches, none, or a task already done change nothing and say why.
  check(name: string, ref: number | string): { changed: boolean; path: string; line?: number; task?: string; why?: string; candidates?: { line: number; text: string }[]; openTasks?: { line: number; text: string }[]; now?: string };
  // Add "- HH:MM text" to today's daily note, making the note where daily notes live when it is not there.
  capture(text: string, o?: { time?: string; under?: string; today?: string }): { changed: true; path: string; created?: true; date: string; line: number; added: number; now?: string };
};
