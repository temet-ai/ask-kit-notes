# ask-kit-notes

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about your own notes: a folder of Markdown files such as an Obsidian vault, a
Logseq graph or a folder of decision records. A cheap model reads the folder outside your agent's
context and answers with the note, the line and the note's date. It also writes to the notes when
asked.

Questions it is for:

- What did I decide about night patrols, and why? (answered by a script)
- What are my open tasks, and which are overdue?
- What did I write this week, and what is in yesterday's daily note?
- Which notes link to `Sam Vimes`, and which links point at notes that do not exist?
- Add a task to `Rota`: check the lamps, due 30 November.

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3 or later. The kit has no
other requirement.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-notes
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-notes        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-notes --yes  # installs and enables it
```

Restart your agents so `ask` lists `notes`. Set `NOTES_DIR` to the folder that holds your notes,
in the environment or in `domains.notes.settings` in ask-kit's config; until it is set the kit is
not offered. The other settings are optional:

| Setting | What it does |
|---|---|
| `NOTES_DAILY` | Where daily notes live and how they are named, such as `daily/YYYY-MM-DD.md`. Found from `.obsidian/daily-notes.json`, a Logseq `journals` folder or notes named like dates when unset. |
| `NOTES_PRIVATE_TAGS` | Tags that make a note private. Default `private,secret`. |
| `WORKDIR` | The folder a relative `NOTES_DIR` is resolved against. Default: the folder the agent runs in. |

## What it carries

`notes.mjs` reads the folder without a Markdown library: titles, aliases, front matter, tags,
`[[wiki links]]`, `![[embeds]]` and Markdown links, headings, tasks and dates. It keeps an index
under ask-kit's state folder, so a later question re-reads only the notes that changed.

Scripts, each answering one kind of question in one call:

- `find`: the notes that hold some words, best first, with passages and dates.
- `decided`: decisions and the reasons written near them. It reads "Decision" and "Outcome"
  headings, lines such as "decided" and "we will", and decision-record files.
- `tasks`: open, overdue and done tasks (`- [ ]`, `📅 2026-11-08`, `due:: 2026-11-08`, Logseq
  `TODO` and `DONE`), grouped by due date or by note.
- `daily`: one day's note with its text and tasks, or a range of days.
- `recent`: what was written or changed since a time, day by day.
- `links`: what links to a note, what it links to and which links are broken.
- `tags`: the tags with their counts, or the notes with one tag.
- `overview`: size, date range, most linked notes, orphans, broken links, and what was left out.

Two questions are answered with no model: "what are my open tasks" and "what's in today's daily
note" (or yesterday's). The kit has no skills or roles. [RECIPE.md](RECIPE.md) says what it reads
and runs, and how to rebuild it.

## What it can change

When asked, five calls write to a note: `notes.append` (at the end, or under a heading),
`notes.create` (a new note; an existing one is refused), `notes.task` (an open task, in the note's
own style), `notes.check` (ticks one task, by line or by its text; several matches change
nothing) and `notes.capture` (a timestamped line in today's daily note). Each throws unless the
caller asked for a change (`act: true`), and each returns the lines as they are afterwards.

An edit touches only the lines it adds or the one task line it ticks. Line endings, front matter
and the order of the note stay as they are. Nothing deletes, renames or moves a note.

What the investigator reads goes to a cloud model, so the kit leaves some things out:

- Hidden folders (`.obsidian`, `.trash`, `.git`, `.logseq`), non-text files (attachments are
  counted), and files or folders named like credentials (`*token*`, `*secret*`, `*password*`,
  `*.env`, `*.pem`, `*.key`, `id_rsa`, cookies and the like) are never opened.
- A note with `private: true` in its front matter, or a tag in `NOTES_PRIVATE_TAGS`, is counted and
  named by title. It is not searched, quoted, linked from or edited.
- On every line returned, the value after `password:`, `token:`, `api key:` and similar, strings
  shaped like known keys, the password in a URL and the body of a private key are replaced with
  `[redacted]`, and searches do not match the hidden value. This works by pattern: a secret
  written in some other way is not caught, so keep such notes private or in a credential-named
  file.

## How well it works

`bench/questions.json` holds 19 questions that run with no model against the fixture vault
`bench/fixture/vault` (a small vault with one fake secret of each kind). Each one's `expect`
patterns were checked against the fixture's output on 2026-11-21, by running every script and
matching the patterns. Run them from the kit's folder with
`NOTES_DIR=bench/fixture/vault ask-kit kit test notes`.

No model run has been made: the bench has no questions from real sessions yet. The kit was run on
Linux, on the fixture only, not on a large vault.

MIT licence.
