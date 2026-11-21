# Recipe: the notes kit

## What it answers

What the user wrote or decided about something and when; open, overdue and done tasks; a day's
daily note or a range of days; what was written or changed since a time; which notes link to a
note, what it links to, which links are broken and which notes are orphans; the tags and the
notes with one. It also acts: adds to a note, makes a note, adds a task, ticks one, captures a
line in today's daily note.

## What it needs

- ask-kit 0.3.0 or newer (`min_ask_kit = "0.3.0"`). No package, no tokens.
- The setting `NOTES_DIR` (required): the folder with the notes. Optional: `NOTES_DAILY`,
  `NOTES_PRIVATE_TAGS` (default `private,secret`) and `WORKDIR` (detected: the folder the agent
  runs in; a relative `NOTES_DIR` or `vault` resolves against it).

## What it reads and runs

It reads `.md`, `.markdown` and `.txt` files under `NOTES_DIR` (or under the folder a script's
`vault` parameter or `notes.at(folder)` names), up to 200000 files of up to 2 MiB each, and
`.obsidian/daily-notes.json` for the daily note pattern. It runs no program and no shell.

Left out, because answers go to a cloud model: folders whose name starts with a dot,
`node_modules` and `logseq/bak`; symbolic links (never followed); non-text files, which are only
counted; files and folders whose name holds token, secret, credential, passw, cookie, `.env`,
`.pem`, `.key`, `id_rsa`, `id_ed25519`, `oauth`, `auth.json` or `hosts.yml`; notes that are
private (front matter `private: true`, or a tag in `NOTES_PRIVATE_TAGS`, a nested tag included),
which keep no headings or task text even in the index. On every returned line `safe()` replaces
the value after `password`, `token`, `secret`, `api key`, `access key`, `private key`,
`recovery code`, `seed phrase`, `bearer` or `credentials` followed by `:` or `=`, strings shaped
like `sk-`, `ghp_`, `github_pat_`, `xox*-`, `AKIA` and JWT tokens, the password in
`scheme://user:password@`, and the body of a private key block. Searches (`find`, `grep`,
`decisions`) run over the masked text, so a hidden value cannot be found by guessing it.

The index is a JSON file under `$ASK_KIT_STATE/notes/` (else `$XDG_STATE_HOME/ask-kit/notes/`),
keyed by path, size and modified time. It holds titles, tags, links, task lines and headings of
notes that are not private, and no note text beyond those.

Dates are plain `YYYY-MM-DD` in local time. A note's date is its front matter `date` or
`created`, else a date in its file name, else the file's modified time (rows then carry
`dateFrom: "file time"`).

Changing calls write only inside the notes folder and only when the caller asked for a change.
`create` refuses an existing note, a path outside the folder, a hidden folder and a
credential-like name. Every edit goes through the file's own lines and line endings.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.notes`, name `notes`, `says`, `keywords`,
`route_hint`, `cite`, `acts = ["notes.append", "notes.create", "notes.task", "notes.check",
"notes.capture"]`, the settings above with `NOTES_DIR` required, one `[[sources]]` of kind
`module`, name `notes`, module `notes.mjs`, api `api.d.ts`, `instructions = "instructions.md"`,
and two reading `[[actions]]`: `open-tasks` and `daily-note`, each with `expect`).

`notes.mjs` exports `make({settings, push, cwd, act})` returning the `notes` global. One walk
lists the files; `parseNote` reads each one line by line, skipping fenced code and inline code,
and keeps the front matter keys, tags (front matter, `#tag`, Logseq `tags::`), aliases, links,
headings, tasks (checkbox or Logseq keyword, with due, scheduled and done dates) and the word
count. A wiki link resolves by path, then file name, then title or alias, never by guess. The
reading functions are `index`, `find`, `grep`, `note`, `backlinks`, `links`, `tags`, `tagged`,
`tasks`, `recent`, `daily`, `dailies`, `unresolved`, `orphans`, `hubs`, `decisions` and `at`.
The five changing functions are built only when `act` is true and otherwise throw
`not in this ask: ...`.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and
`export default async function ({notes}, params)`, each returning a one-line `verdict` first):
`find`, `decided`, `tasks`, `daily`, `recent`, `links`, `tags`, `overview`. Each takes `vault` for
another folder and `today` where a date matters.

`instructions.md` has the docker kit's structure: how to work (scripts first; how dates and tasks
are read; private and credential notes are named and never quoted; changing only when asked, and
reporting the lines written), and the answer format.

`bench/fixture/vault` is the Ankh-Morpork City Watch's notes: people, cases, decision records, a
rota, four daily notes, a `.obsidian` folder, a `.trash` note, an attachment, a note named
`clacks-token.md`, notes private by front matter and by tag, and a note with a fake password, a
fake URL password and a fake key. `bench/questions.json` holds shots against it.

## Bench

`NOTES_DIR=bench/fixture/vault ask-kit kit test notes`, from the kit's folder. All 19 questions
are shots (`do`): no model is called. Questions for a model (`q`) are still to be added from real
sessions, in which an agent searched a notes folder by hand.

## Results

Each script was run on the fixture on 2026-11-21 with `ask-kit run notes <script>`, and the 19 `expect` lists matched (19/19); `ask-kit kit test` itself was not run. The
five changing calls were run on a copy of the fixture: held without `act`, run with it, and a
diff of the copy showed only the lines added or ticked. No model run has been made.
