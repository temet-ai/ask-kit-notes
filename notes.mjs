// A person's notes for ask-kit: a folder of Markdown or plain text files (an Obsidian vault, a
// Logseq graph, a ~/notes folder, a team's decision records) read without a Markdown library.
//
// The folder is indexed once by reading each note in turn: title, aliases, tags, links out, tasks,
// headings, dates and word count. The index is kept under ask-kit's state folder, keyed by path,
// size and modified time, so only new and changed notes are read again.
//
// What never reaches the investigator, because what it reads goes to a cloud model:
// - folders whose name starts with a dot (.obsidian, .trash, .git, .logseq), node_modules, logseq/bak;
// - files that are not .md, .markdown or .txt (attachments are counted, never opened);
// - files and folders named like credentials (the dotfiles kit's globs: *token*, *secret*, *.env ...);
// - notes whose front matter says `private: true` or that carry a tag listed in NOTES_PRIVATE_TAGS:
//   those are counted and named by title, never searched, quoted or edited;
// - on every returned line, the value after `password:`, `token:`, `api key:` and the like, tokens
//   of a known shape, the password in a URL and the body of a private key.
//
// Reading is always on. append, create, task, check and capture are built only when the caller
// asked for a change (act); without it they throw. An edit touches only the lines it adds or the
// one task line it ticks: line endings, front matter and the order of the note stay as they are.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1; // of the index file: raise it when parseNote changes what it stores
const NOTE_EXT = new Set([".md", ".markdown", ".txt"]);
const MAX_NOTE_BYTES = 2 << 20;
const MAX_FILES = 200_000;
const FRESH_MS = 1500; // calls this close together share one look at the folder
const CRED = [/\.env$/, /token/, /secret/, /credential/, /passw/, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/, /^oauth/, /^auth\.json$/, /^hosts\.yml$/, /cookie/];
const STOP = new Set("the a an and or of to in on for with what how does do did is are was were it this that i my me we our be can when where which who why about from into at by as have has had not".split(" "));

const expand = (p) => (typeof p === "string" ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);
const stateRoot = () => process.env.ASK_KIT_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "ask-kit");
const credNamed = (segment) => CRED.some((r) => r.test(segment.toLowerCase()));
const clip = (s, n = 240) => (s.length > n ? s.slice(0, n) + "…" : s);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const offInThisAsk = (what) => `not in this ask: ${what} changes things, and the caller did not ask for a change (act: true)`;

// ---- secrets on a line ----

const SECRET_KV = /((?:pass(?:word|wd|phrase|code)?|pwd|tokens?|secrets?|api[ _-]?keys?|access[ _-]?keys?|private[ _-]?keys?|recovery (?:code|key|phrase)s?|seed phrase|bearer|credentials?)\b[^:=\n]{0,24}[:=]\s*)(\S.*)$/i;
const SECRET_SHAPE = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;

/** A line with anything that looks like a credential replaced by [redacted]. */
export function safe(line) {
  return String(line).replace(URL_PASSWORD, "$1[redacted]@").replace(SECRET_SHAPE, "[redacted]").replace(SECRET_KV, "$1[redacted]");
}
/** Lines made safe; the body of a private key block is dropped. */
function safeLines(lines) {
  let inKey = false;
  return lines.map((l) => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l)) return (inKey = true), "[redacted private key]";
    if (inKey) return /-----END [A-Z ]*PRIVATE KEY-----/.test(l) ? ((inKey = false), "") : "";
    return safe(l);
  });
}

/** A whole text with credentials masked, so a search never matches a value that is never shown. */
const masked = (text) => safeLines(text.split(/\r?\n/)).join("\n");

// ---- dates: plain YYYY-MM-DD strings, local time ----

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const validDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200;
const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 is Sunday
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The first date in a string, as YYYY-MM-DD, or null. */
function dateIn(s) {
  const m = /(?<!\d)(\d{4})[-_./](\d{1,2})[-_./](\d{1,2})(?!\d)/.exec(String(s ?? ""));
  if (m && validDay(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  const c = /(?<!\d)(20\d\d)(\d\d)(\d\d)(?:\d{4}|\d{6})?(?!\d)/.exec(String(s ?? ""));
  if (c && validDay(+c[1], +c[2], +c[3])) return `${c[1]}-${c[2]}-${c[3]}`;
  return null;
}

/** `today` as given (YYYY-MM-DD) or the machine's date. */
function todayOf(today) {
  if (today == null || today === "") return ymd(new Date());
  const d = dateIn(today);
  if (!d) throw new Error(`today must be a date like 2026-11-08, not "${today}"`);
  return d;
}

/** A point in time in the words people use: a date, "today", "yesterday", "7d", "2w", "3m", "week", "month". */
function when(spec, today) {
  const s = String(spec).trim().toLowerCase();
  const d = dateIn(s);
  if (d) return d;
  if (/^\d{4}-\d\d$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (s === "today" || s === "now") return today;
  if (s === "yesterday") return addDays(today, -1);
  if (s === "tomorrow") return addDays(today, 1);
  if (s === "week" || s === "this week") return addDays(today, -((weekday(today) + 6) % 7));
  if (s === "last week") return addDays(today, -((weekday(today) + 6) % 7) - 7);
  if (s === "month" || s === "this month") return `${today.slice(0, 8)}01`;
  if (s === "year" || s === "this year") return `${today.slice(0, 4)}-01-01`;
  const m = /^(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)$/.exec(s);
  if (m) return addDays(today, -Number(m[1]) * { d: 1, w: 7, m: 30, y: 365 }[m[2][0]]);
  throw new Error(`"${spec}" is not a time: use a date (2026-11-08), today, yesterday, week, month, or a span back such as 7d, 2w, 3m`);
}

// ---- reading one note ----

const unquote = (v) => {
  const s = String(v).trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
};
const listOf = (v, sep) => (v == null ? [] : Array.isArray(v) ? v : String(v).split(sep)).map((x) => String(x).trim()).filter(Boolean);

/** YAML front matter, read narrowly: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. */
function frontMatter(lines) {
  if ((lines[0] ?? "").trim() !== "---") return { data: {}, end: 0 };
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 300); i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { data: {}, end: 0 };
  const data = {};
  let key = null;
  for (let i = 1; i < end; i++) {
    const l = lines[i];
    let m;
    if ((m = /^([A-Za-z_][\w -]*?)\s*:\s*(.*)$/.exec(l))) {
      key = m[1].toLowerCase();
      const v = m[2].trim();
      if (v === "" || v === "|" || v === ">") data[key] = [];
      else if (v.startsWith("[") && v.endsWith("]") && !v.startsWith("[[")) data[key] = v.slice(1, -1).split(",").map(unquote).filter(Boolean);
      else data[key] = unquote(v);
    } else if (key && Array.isArray(data[key]) && (m = /^\s*-\s+(.*)$/.exec(l))) data[key].push(unquote(m[1]));
  }
  return { data, end: end + 1 };
}

const FENCE = /^\s*(?:[-*]\s+)?(`{3,}|~{3,})/;
const HEADING = /^\s*(?:-\s+)?(#{1,6})\s+(.*?)\s*#*\s*$/;
const WIKI = /(!?)\[\[([^[\]|#\n]*)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const TAG = /(?:^|[^\p{L}\p{N}_#&/])#([\p{L}\p{N}_\-/]+)/gu;
const CHECKBOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/;
const LOGSEQ_TASK = /^(\s*)[-*]\s+(TODO|DOING|NOW|LATER|WAITING|IN-PROGRESS|DONE|CANCELED|CANCELLED)\s+(.*)$/;
const DAY = "(\\d{4}-\\d\\d-\\d\\d)";
const DUE = new RegExp(`(?:📅|🗓)\\uFE0F?\\s*${DAY}|\\b(?:due|deadline)::?\\s*\\[?\\[?${DAY}|@due\\(${DAY}\\)`, "i");
const SCHEDULED = new RegExp(`⏳\\s*${DAY}|\\bscheduled::\\s*\\[?\\[?${DAY}`, "i");
const DONE_ON = new RegExp(`✅\\s*${DAY}|\\b(?:completion|completed|done)::\\s*\\[?\\[?${DAY}`, "i");
const first = (m) => (m ? m.slice(1).find(Boolean) : undefined);

/** A line with inline code, comments, link targets and wiki links blanked, so a tag scan sees prose only. */
const prose = (line) => line.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)).replace(/%%.*?%%|<!--.*?-->/g, (m) => " ".repeat(m.length));

/**
 * What the index keeps of one note. Lines are 1-based. Fenced code blocks and inline code are
 * skipped for tags, links, tasks and headings. Short keys, because a large vault makes a large file.
 */
export function parseNote(text) {
  const lines = text.split(/\r?\n/);
  const { data, end } = frontMatter(lines);
  const tags = new Set();
  const addTag = (t) => {
    const v = String(t).replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
    if (v && /[^\d/]/.test(v)) tags.add(v);
  };
  listOf(data.tags ?? data.tag, /[,\s]+/).forEach(addTag);
  const aliases = listOf(data.aliases ?? data.alias, ",");
  const props = {};
  const links = [];
  const tasks = [];
  const headings = [];
  let words = 0;
  let fence = null;
  let lastTask = null;
  let pageProps = true; // Logseq: `key:: value` lines before any other text belong to the page
  for (let i = end; i < lines.length; i++) {
    const raw = lines[i];
    const f = FENCE.exec(raw);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*[`~]+\s*$/.test(raw)) fence = null;
      words += (raw.match(/\S+/g) ?? []).length;
      continue;
    }
    if (f) {
      fence = f[1];
      pageProps = false;
      continue;
    }
    if (!raw.trim()) continue;
    words += (raw.match(/\S+/g) ?? []).length;
    const line = prose(raw);
    let m;

    if (pageProps && (m = /^\s*(?:-\s+)?([A-Za-z_][\w-]*)::\s*(.*)$/.exec(raw))) {
      const k = m[1].toLowerCase();
      if (k === "tags" || k === "tag") listOf(m[2].replace(/\[\[|\]\]/g, ""), /[,\s]+/).forEach(addTag);
      else if (k === "alias" || k === "aliases") aliases.push(...listOf(m[2].replace(/\[\[|\]\]/g, ""), ","));
      else if (!(k in data)) data[k] = m[2].trim();
    } else pageProps = false;

    if ((m = HEADING.exec(line)) && m[2]) headings.push({ l: i + 1, v: m[1].length, x: clip(raw.replace(/^\s*(?:-\s+)?#{1,6}\s+/, "").replace(/\s*#*\s*$/, ""), 160) });

    for (const w of line.matchAll(WIKI)) {
      const t = w[2].trim();
      if (!t) continue; // [[#Heading]] points into the same note
      links.push({ l: i + 1, t, ...(w[3] ? { h: w[3].trim() } : {}), ...(w[4] ? { a: w[4].trim() } : {}), ...(w[1] ? { e: 1 } : {}) });
    }
    for (const w of line.matchAll(MDLINK)) {
      let t = w[3];
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t)) continue; // a URL, or an anchor in the same note
      try {
        t = decodeURIComponent(t);
      } catch {}
      const hash = t.indexOf("#");
      const target = hash < 0 ? t : t.slice(0, hash);
      const ext = path.posix.extname(target).toLowerCase();
      if (!target || (ext && !NOTE_EXT.has(ext))) continue; // an image or another attachment
      links.push({ l: i + 1, t: target, r: 1, ...(hash >= 0 && t.slice(hash + 1) ? { h: t.slice(hash + 1) } : {}), ...(w[2] ? { a: w[2] } : {}), ...(w[1] ? { e: 1 } : {}) });
    }

    const lineTags = [];
    for (const w of line.replace(WIKI, (x) => " ".repeat(x.length)).replace(/\]\([^)]*\)/g, (x) => " ".repeat(x.length)).matchAll(TAG)) {
      const v = w[1].replace(/\/+$/, "").toLowerCase();
      if (!v || !/[^\d/]/.test(v)) continue; // #12 is a number, not a tag
      tags.add(v);
      lineTags.push(v);
    }

    const box = CHECKBOX.exec(line) ? CHECKBOX.exec(raw) : null;
    const todo = box ? null : LOGSEQ_TASK.exec(line) ? LOGSEQ_TASK.exec(raw) : null;
    if (box || todo) {
      const s = box ? (/[xX]/.test(box[2]) ? "x" : box[2] === "-" ? "-" : " ") : /^DONE$/.test(todo[2]) ? "x" : /^CANCEL/.test(todo[2]) ? "-" : " ";
      const body = (box ?? todo)[3];
      lastTask = { l: i + 1, x: clip(body.trim(), 240), s, ...(todo ? { k: 1 } : {}) };
      const due = first(DUE.exec(body));
      const sch = first(SCHEDULED.exec(body));
      const dn = first(DONE_ON.exec(body));
      if (due) lastTask.d = due;
      if (sch) lastTask.c = sch;
      if (dn) lastTask.n = dn;
      if (lineTags.length) lastTask.g = [...new Set(lineTags)];
      tasks.push(lastTask);
    } else if (lastTask && i + 1 - lastTask.l <= 3 && (m = /^\s*(DEADLINE|SCHEDULED):\s*<(\d{4}-\d\d-\d\d)/.exec(raw) ?? /^\s+(due|deadline|scheduled)::\s*\[?\[?(\d{4}-\d\d-\d\d)/i.exec(raw))) {
      if (/^sch/i.test(m[1])) lastTask.c ??= m[2];
      else lastTask.d ??= m[2];
    }
  }
  for (const k of ["status", "type", "project", "author", "area"]) if (typeof data[k] === "string" && data[k]) props[k] = clip(data[k], 80);
  const isPrivate = /^(true|yes|on|1)$/i.test(String(data.private ?? ""));
  const out = { w: words, e: end };
  if (typeof data.title === "string" && data.title) out.t = clip(data.title, 200);
  const h1 = headings.find((h) => h.v === 1);
  if (h1) out.h1 = h1.x;
  if (aliases.length) out.al = [...new Set(aliases.map((a) => clip(a, 120)))];
  if (tags.size) out.g = [...tags];
  if (links.length) out.k = links;
  const d = dateIn(Array.isArray(data.date) ? "" : data.date);
  const c = dateIn(Array.isArray(data.created) ? "" : data.created);
  const u = dateIn([data.updated, data.modified, data["last-modified"], data.last_modified].find((v) => typeof v === "string"));
  if (d) out.d = d;
  if (c) out.c = c;
  if (u) out.u = u;
  if (Object.keys(props).length) out.pr = props;
  if (isPrivate) out.p = 1; // a private note keeps no headings and no task text, even in the index
  else {
    if (headings.length) out.hd = headings;
    if (tasks.length) out.q = tasks;
  }
  return out;
}

// ---- walking the folder ----

function walk(root) {
  const out = { files: [], attachments: 0, attachmentNames: new Set(), credentialNamed: [], hiddenFolders: new Set(), tooBig: [], truncated: false };
  const stack = [""];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never followed: a link can leave the folder or loop
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || e.name === "node_modules" || (dir === "logseq" && e.name === "bak")) {
          if (e.name.startsWith(".")) out.hiddenFolders.add(dir ? rel : e.name);
        } else if (credNamed(e.name)) out.credentialNamed.push(`${rel}/`);
        else stack.push(rel);
        continue;
      }
      if (!e.isFile() || e.name.startsWith(".")) continue;
      if (credNamed(e.name)) {
        out.credentialNamed.push(rel);
        continue;
      }
      if (!NOTE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.attachments++;
        out.attachmentNames.add(e.name.toLowerCase());
        continue;
      }
      if (out.files.length >= MAX_FILES) {
        out.truncated = true;
        continue;
      }
      let st;
      try {
        st = fs.statSync(path.join(root, rel));
      } catch {
        continue;
      }
      if (st.size > MAX_NOTE_BYTES) {
        out.tooBig.push(rel);
        continue;
      }
      out.files.push({ rel, size: st.size, mtime: Math.floor(st.mtimeMs), birth: Math.floor(st.birthtimeMs || st.mtimeMs) });
    }
  }
  out.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// ---- where daily notes live ----

const TOKEN = /\[([^\]]*)\]|YYYY|MMMM|MMM|MM|DD|dddd|ddd|(?<![A-Za-z])YY(?![A-Za-z])|(?<![A-Za-z])M(?![A-Za-z])|(?<![A-Za-z])D(?![A-Za-z])/g;
const TOKEN_RE = { YYYY: "(?<y>\\d{4})", YY: "(?<yy>\\d{2})", MMMM: "(?<mon>[A-Za-z]+)", MMM: "(?<mon>[A-Za-z]+)", MM: "(?<m>\\d{2})", M: "(?<m>\\d{1,2})", DD: "(?<d>\\d{2})", D: "(?<d>\\d{1,2})", dddd: "[A-Za-z]+", ddd: "[A-Za-z]+" };

/** A pattern such as `daily/YYYY-MM-DD.md` as a regex over a note's path and a function from a date to a path. */
function dailyPattern(pattern) {
  let p = String(pattern).trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!NOTE_EXT.has(path.posix.extname(p).toLowerCase())) p += ".md";
  const segments = p.split("/");
  // A folder segment is a date only when it is all tokens ("YYYY", "YYYY-MM"); "Daily" keeps its D.
  const dated = segments.map((s, i) => i === segments.length - 1 || s.replace(TOKEN, "").replace(/[-_. ]/g, "") === "");
  let re = "";
  const used = new Set();
  const parts = segments.map((s, i) => {
    if (!dated[i]) return (re += esc(s) + (i < segments.length - 1 ? "/" : "")), [{ lit: s }];
    const out = [];
    let at = 0;
    for (const m of s.matchAll(TOKEN)) {
      if (m.index > at) out.push({ lit: s.slice(at, m.index) });
      out.push(m[1] != null ? { lit: m[1] } : { tok: m[0] });
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push({ lit: s.slice(at) });
    for (const x of out) {
      if (x.lit != null) re += esc(x.lit);
      else {
        // A named group can appear once; a repeated token (YYYY/YYYY-MM-DD) matches the same digits again.
        const g = /\?<(\w+)>/.exec(TOKEN_RE[x.tok])?.[1];
        re += g && used.has(g) ? TOKEN_RE[x.tok].replace(/\?<\w+>/, "?:") : TOKEN_RE[x.tok];
        if (g) used.add(g);
      }
    }
    if (i < segments.length - 1) re += "/";
    return out;
  });
  const regex = new RegExp(`^${re}$`, "i");
  return {
    pattern: p,
    dayOf(rel) {
      const g = regex.exec(rel)?.groups;
      if (!g) return null;
      const y = g.y ? +g.y : g.yy ? 2000 + +g.yy : null;
      const m = g.m ? +g.m : g.mon ? MONTHS.findIndex((n) => n.toLowerCase().startsWith(g.mon.toLowerCase().slice(0, 3))) + 1 : null;
      const d = g.d ? +g.d : null;
      return y && m && d && validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
    },
    pathOf(day) {
      const [y, m, d] = day.split("-");
      const v = { YYYY: y, YY: y.slice(2), MMMM: MONTHS[+m - 1], MMM: MONTHS[+m - 1].slice(0, 3), MM: m, M: String(+m), DD: d, D: String(+d), dddd: DOW[weekday(day)], ddd: DOW[weekday(day)].slice(0, 3) };
      return parts.map((seg) => seg.map((x) => x.lit ?? v[x.tok]).join("")).join("/");
    },
  };
}

function detectDaily(root, files) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(root, ".obsidian", "daily-notes.json"), "utf8"));
    const folder = String(o.folder ?? "").replace(/^\/+|\/+$/g, "");
    return { pattern: `${folder ? `${folder}/` : ""}${o.format || "YYYY-MM-DD"}.md`, from: ".obsidian/daily-notes.json" };
  } catch {}
  const counts = new Map();
  for (const f of files) {
    const m = /^(.*\/)?(\d{4})([-_.])(\d\d)\3(\d\d)(\.\w+)$/.exec(f.rel);
    if (!m) continue;
    // A year or month folder above the note (journal/2026/11/2026-11-08.md) is part of the pattern.
    const dir = (m[1] ?? "").split("/").map((x) => (x === m[2] ? "YYYY" : x === m[4] && /^\d\d$/.test(x) ? "MM" : x)).join("/");
    const key = `${dir}YYYY${m[3]}MM${m[3]}DD${m[6]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (best) return { pattern: best[0], from: `${best[1]} notes named like dates` };
  if (fs.existsSync(path.join(root, "journals"))) return { pattern: "journals/YYYY_MM_DD.md", from: "a Logseq journals folder" };
  return { pattern: "YYYY-MM-DD.md", from: "nothing found; the default" };
}

// ---- the vault ----

function tokens(words) {
  const all = String(Array.isArray(words) ? words.join(" ") : words ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const kept = all.filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(kept.length ? kept : all)].slice(0, 8);
}
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** How often `w` starts a word in `low` (already lower case), counted up to `cap`. */
function countWord(low, w, cap = 6) {
  let n = 0;
  for (let at = low.indexOf(w); at >= 0 && n < cap; at = low.indexOf(w, at + w.length)) if (at === 0 || !WORD_CHAR.test(low[at - 1])) n++;
  return n;
}

const DECISION_HEAD = /^(decisions?|decided|outcome|resolution|verdict|ruling|what we decided)\b/i;
const DECISION_LINE = /\b(decided|decision:|we will|we'll|we agreed|agreed (?:to|that)|we chose|chose to|going with|we are going to|settled on|resolved to|ruling:)/i;
const REASON = /\b(because|since|so that|reasons?|rationale|why|due to|in order to|otherwise|trade-?offs?)\b/i;
const REASON_HEAD = /^(why|rationale|reasons?|context|consequences|background)\b/i;
const ADR_PATH = /(^|[/\s_-])adr[-_ ]?\d+|(^|\/)(decisions?|adrs?|decision[-_ ]records?)\//i;
const TASK_HEAD = /^(tasks?|to-?dos?|to do|actions?|action items|next( steps| actions)?)\b/i;

function makeVault({ root, settings, push, act, workdir }) {
  const privateTags = String(settings.NOTES_PRIVATE_TAGS ?? "private,secret").split(",").map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
  const cacheFile = path.join(stateRoot(), "notes", `${path.basename(root).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "root"}-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 10)}.json`);
  const note = (kind, detail, started, size) => push?.({ kind, detail: String(detail).slice(0, 200), ms: Date.now() - started, code: 0, size });
  let records = null; // rel -> what parseNote kept, with size and mtime
  let snap = null;

  function load() {
    if (snap && Date.now() - snap.at < FRESH_MS) return snap;
    const started = Date.now();
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`the notes folder ${root} does not exist: set NOTES_DIR to the folder that holds the notes (in the environment or in domains.notes.settings in ask-kit's config), or pass another folder as \`vault\``);
    }
    let fromCache = false;
    if (!records) {
      records = new Map();
      try {
        const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (saved.v === VERSION && saved.root === root) {
          records = new Map(Object.entries(saved.notes));
          fromCache = true;
        }
      } catch {}
    }
    const w = walk(root);
    let parsed = 0;
    let reused = 0;
    const next = new Map();
    for (const f of w.files) {
      const old = records.get(f.rel);
      if (old && old.s === f.size && old.m === f.mtime) {
        next.set(f.rel, old);
        reused++;
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(path.join(root, f.rel), "utf8");
      } catch {
        continue;
      }
      next.set(f.rel, { s: f.size, m: f.mtime, b: f.birth, ...parseNote(text) });
      parsed++;
    }
    const changed = parsed > 0 || next.size !== records.size;
    records = next;
    if (changed) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, root, notes: Object.fromEntries(records) }));
        fs.renameSync(tmp, cacheFile);
      } catch {}
    }
    const dailySetting = String(settings.NOTES_DAILY ?? "").trim();
    const dailyFound = dailySetting ? { pattern: dailySetting, from: "NOTES_DAILY" } : detectDaily(root, w.files);
    const daily = { ...dailyPattern(dailyFound.pattern), from: dailyFound.from };

    const notes = [];
    for (const [rel, r] of records) {
      const name = path.posix.basename(rel, path.posix.extname(rel));
      const tags = r.g ?? [];
      const nameDay = dateIn(name);
      const explicit = r.d ?? r.c ?? daily.dayOf(rel) ?? nameDay ?? null;
      const mday = ymd(new Date(r.m));
      notes.push({
        rel,
        name,
        low: rel.toLowerCase(),
        title: r.t ?? name,
        aliases: r.al ?? [],
        h1: r.h1,
        tags,
        links: r.k ?? [],
        tasks: r.q ?? [],
        headings: r.hd ?? [],
        props: r.pr ?? {},
        words: r.w,
        fmEnd: r.e,
        date: explicit, // from front matter or the file name; null when the note says nothing
        day: explicit ?? mday, // the date results carry
        dayFrom: explicit ? (r.d || r.c ? "front matter" : "file name") : "file time",
        created: r.c ?? r.d ?? daily.dayOf(rel) ?? nameDay ?? ymd(new Date(Math.min(r.b ?? r.m, r.m))),
        modified: r.u ?? mday,
        modifiedFrom: r.u ? "front matter" : "file time",
        private: !!r.p || tags.some((t) => privateTags.some((p) => t === p || t.startsWith(`${p}/`))),
        dailyDay: daily.dayOf(rel),
      });
    }
    snap = { at: Date.now(), notes, open: notes.filter((n) => !n.private), hidden: notes.filter((n) => n.private), walk: w, daily, stats: { parsed, reused, fromCache, ms: Date.now() - started } };
    note("index", `${root}: ${notes.length} notes, ${parsed} read`, started, notes.length);
    return snap;
  }
  const stale = () => {
    snap = null;
  };

  // ---- names and links ----

  function maps(s) {
    if (s.maps) return s.maps;
    const byPath = new Map();
    const byName = new Map();
    const byTitle = new Map();
    const add = (map, k, n) => {
      const key = k.toLowerCase();
      const have = map.get(key);
      if (have) have.push(n);
      else map.set(key, [n]);
    };
    for (const n of s.notes) {
      byPath.set(n.low, n);
      byPath.set(n.low.slice(0, n.low.length - path.posix.extname(n.low).length), n);
      add(byName, n.name, n);
      for (const t of new Set([n.title, ...n.aliases, ...(n.h1 ? [n.h1] : [])].map((x) => x.toLowerCase()))) add(byTitle, t, n);
    }
    return (s.maps = { byPath, byName, byTitle });
  }
  const shortest = (list) => [...list].sort((a, b) => a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1));
  const cleanName = (name) =>
    String(name ?? "")
      .trim()
      .replace(/^!?\[\[|\]\]$/g, "")
      .replace(/[|#].*$/, "")
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .trim();

  /** Resolve a name the way a wiki link does: path, file name, then title or alias. No guessing. */
  function resolveExact(s, name, from) {
    const m = maps(s);
    const t = cleanName(name).toLowerCase();
    if (!t) return null;
    const bare = NOTE_EXT.has(path.posix.extname(t)) ? t.slice(0, -path.posix.extname(t).length) : t;
    if (from) {
      const near = m.byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(from.low), bare)));
      if (near) return { note: near, how: "path", others: [] };
    }
    const direct = m.byPath.get(bare);
    if (direct) return { note: direct, how: "path", others: [] };
    if (bare.includes("/")) {
      const ends = s.notes.filter((n) => n.low.slice(0, n.low.length - path.posix.extname(n.low).length).endsWith(`/${bare}`));
      if (ends.length) return { note: shortest(ends)[0], how: "path", others: shortest(ends).slice(1) };
    }
    const named = m.byName.get(path.posix.basename(bare));
    if (named && !bare.includes("/")) {
      const sorted = from ? [...named.filter((n) => path.posix.dirname(n.rel) === path.posix.dirname(from.rel)), ...shortest(named)] : shortest(named);
      const uniq = [...new Set(sorted)];
      return { note: uniq[0], how: "file name", others: uniq.slice(1) };
    }
    const titled = m.byTitle.get(bare);
    if (titled) {
      const n = shortest(titled)[0];
      return { note: n, how: n.title.toLowerCase() === bare || (n.h1 ?? "").toLowerCase() === bare ? "title" : "alias", others: shortest(titled).slice(1) };
    }
    return null;
  }

  /** A name the caller gives: exact first, then a substring of a file name, title or alias. */
  function resolve(s, name) {
    const exact = resolveExact(s, name);
    if (exact) return { ...exact, exact: true };
    const t = cleanName(name).toLowerCase();
    if (!t) return null;
    const hits = s.notes.filter((n) => n.name.toLowerCase().includes(t) || n.title.toLowerCase().includes(t) || n.aliases.some((a) => a.toLowerCase().includes(t)) || n.low.includes(t));
    if (!hits.length) return null;
    const sorted = hits.sort((a, b) => a.name.length - b.name.length || (a.day < b.day ? 1 : -1));
    return { note: sorted[0], how: "substring", others: sorted.slice(1), exact: false };
  }

  const near = (s, name) => {
    const q = tokens(cleanName(name));
    return s.open
      .map((n) => ({ n, k: q.filter((w) => `${n.name} ${n.title} ${n.aliases.join(" ")}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.k)
      .sort((a, b) => b.k - a.k)
      .slice(0, 6)
      .map((x) => x.n.rel);
  };

  function graph(s) {
    if (s.graph) return s.graph;
    const inbound = new Map(); // rel -> [{from, link}]
    const out = new Map(); // rel -> [{link, to}]
    const unresolved = [];
    for (const n of s.notes) {
      const mine = [];
      for (const k of n.links) {
        const r = resolveExact(s, k.t, n);
        const ext = path.posix.extname(k.t).toLowerCase();
        const attachment = !r && /^\.[a-z0-9]{2,5}$/.test(ext) && !NOTE_EXT.has(ext);
        if (attachment) continue;
        mine.push({ link: k, to: r?.note ?? null });
        if (r) {
          if (r.note === n) continue;
          const list = inbound.get(r.note.rel);
          if (list) list.push({ from: n, link: k });
          else inbound.set(r.note.rel, [{ from: n, link: k }]);
        } else unresolved.push({ from: n, link: k });
      }
      out.set(n.rel, mine);
    }
    return (s.graph = { inbound, out, unresolved });
  }

  // ---- reading files ----

  function readLines(n) {
    const started = Date.now();
    let text;
    try {
      text = fs.readFileSync(path.join(root, n.rel), "utf8");
    } catch {
      return null;
    }
    note("read", n.rel, started, text.length);
    return text.split(/\r?\n/);
  }
  const headingAt = (n, line) => {
    let h = null;
    for (const x of n.headings) {
      if (x.l > line) break;
      h = x;
    }
    return h?.x ?? null;
  };
  const row = (n) => ({ path: n.rel, title: n.title, date: n.day, ...(n.dayFrom === "file time" ? { dateFrom: "file time" } : {}) });
  const hiddenRow = (n) => ({ title: n.title, private: true });
  const refuseHidden = (n, what) => {
    if (n.private) throw new Error(`"${n.title}" is private (private: true in its front matter, or one of the tags ${privateTags.join(", ")}): this kit does not ${what} it. Open it yourself.`);
  };

  function pool(s, o = {}, today) {
    let list = s.open;
    if (o.tag) {
      const t = String(o.tag).replace(/^#/, "").toLowerCase();
      list = list.filter((n) => n.tags.some((x) => x === t || x.startsWith(`${t}/`)));
    }
    if (o.in) {
      const f = String(o.in).replace(/\\/g, "/").replace(/^\.?\/|\/$/g, "").toLowerCase();
      list = list.filter((n) => n.low.startsWith(`${f}/`) || n.low === f || path.posix.dirname(n.low).includes(f));
    }
    if (o.since) {
      const d = when(o.since, today);
      list = list.filter((n) => n.day >= d);
    }
    if (o.until) {
      const d = when(o.until, today);
      list = list.filter((n) => n.day <= d);
    }
    return list;
  }

  // ---- what the investigator calls ----

  const api = {
    root,

    /** The vault in numbers, and what was left out of it. */
    index() {
      const s = load();
      const g = graph(s);
      const tasks = s.open.flatMap((n) => n.tasks);
      const tags = new Set(s.open.flatMap((n) => n.tags));
      const days = s.open.map((n) => n.day).sort();
      return {
        root,
        notes: s.notes.length,
        words: s.open.reduce((a, n) => a + n.words, 0),
        tags: tags.size,
        links: s.open.reduce((a, n) => a + n.links.length, 0),
        unresolvedLinks: g.unresolved.filter((u) => !u.from.private).length,
        tasks: { open: tasks.filter((t) => t.s === " ").length, done: tasks.filter((t) => t.s === "x").length, cancelled: tasks.filter((t) => t.s === "-").length },
        dailyNotes: { pattern: s.daily.pattern, from: s.daily.from, count: s.notes.filter((n) => n.dailyDay).length },
        oldest: days[0] ?? null,
        newest: days.at(-1) ?? null,
        private: { count: s.hidden.length, titles: s.hidden.slice(0, 30).map((n) => n.title), why: `front matter private: true, or a tag of ${privateTags.join(", ")}; named by title only, never searched or quoted` },
        leftOut: {
          attachments: s.walk.attachments,
          credentialNamed: s.walk.credentialNamed.length,
          hiddenFolders: [...s.walk.hiddenFolders].slice(0, 12),
          tooBig: s.walk.tooBig.slice(0, 10),
          ...(s.walk.truncated ? { beyondLimit: `only the first ${MAX_FILES} notes are indexed` } : {}),
        },
        index: { file: cacheFile, read: s.stats.parsed, reused: s.stats.reused, ms: s.stats.ms },
      };
    },

    /** Notes about some words, best first: title and alias matches, then headings, then body; rare words weigh more. */
    find(words, o = {}) {
      const q = tokens(words);
      if (!q.length) throw new Error('find needs words, for example notes.find("clacks ledger")');
      const today = todayOf(o.today);
      const s = load();
      const list = pool(s, o, today);
      const max = Math.max(1, Math.min(Number(o.max ?? 8), 30));
      const started = Date.now();
      const df = q.map(() => 0);
      const hits = [];
      for (const n of list) {
        let text;
        try {
          text = fs.readFileSync(path.join(root, n.rel), "utf8");
        } catch {
          continue;
        }
        const low = masked(text).toLowerCase();
        const head = `${n.name} ${n.title} ${n.aliases.join(" ")}`.toLowerCase();
        const heads = n.headings.map((h) => h.x).join("\n").toLowerCase();
        const body = q.map((w) => countWord(low, w));
        const inTitle = q.map((w) => countWord(head, w, 1));
        if (!body.some(Boolean) && !inTitle.some(Boolean)) continue;
        q.forEach((_, i) => (body[i] || inTitle[i]) && df[i]++);
        hits.push({ n, body, inTitle, inHead: q.map((w) => countWord(heads, w, 1)) });
      }
      note("search", q.join(" "), started, hits.length);
      const idf = df.map((d) => Math.log(1 + list.length / Math.max(1, d)));
      for (const h of hits) {
        const matched = q.filter((_, i) => h.body[i] || h.inTitle[i]).length;
        let score = 0;
        q.forEach((_, i) => (score += idf[i] * (h.inTitle[i] * 8 + h.inHead[i] * 4 + Math.sqrt(h.body[i]))));
        h.matched = matched;
        h.score = Math.round(score * (matched / q.length) ** 2 * 10) / 10;
        h.where = [...(h.inTitle.some(Boolean) ? ["title"] : []), ...(h.inHead.some(Boolean) ? ["heading"] : []), ...(h.body.some(Boolean) ? ["body"] : [])];
      }
      hits.sort((a, b) => b.score - a.score || (a.n.day < b.n.day ? 1 : a.n.day > b.n.day ? -1 : 0));
      const notes = hits.slice(0, max).map((h) => {
        const lines = readLines(h.n) ?? [];
        const scored = [];
        for (let i = h.n.fmEnd; i < lines.length; i++) {
          const low = lines[i].toLowerCase();
          const k = q.reduce((a, w, j) => a + (countWord(low, w, 1) ? idf[j] : 0), 0);
          if (k) scored.push({ i, k: k + (/^\s*#{1,6}\s/.test(lines[i]) ? 0.01 : 0) });
        }
        const best = scored.sort((a, b) => b.k - a.k || a.i - b.i).slice(0, 3).sort((a, b) => a.i - b.i);
        return {
          ...row(h.n),
          score: h.score,
          matched: h.where,
          ...(h.matched < q.length ? { missing: q.filter((_, i) => !h.body[i] && !h.inTitle[i]) } : {}),
          ...(h.n.tags.length ? { tags: h.n.tags.slice(0, 8) } : {}),
          passages: best.map(({ i }) => ({ line: i + 1, heading: headingAt(h.n, i + 1), text: clip(safe(lines[i].trim())) })),
        };
      });
      const hiddenHits = s.hidden.filter((n) => q.some((w) => countWord(`${n.name} ${n.title}`.toLowerCase(), w, 1))).map((n) => n.title);
      return {
        words: q,
        notes,
        total: hits.length,
        ...(hits.length > max ? { leftOut: hits.length - max } : {}),
        searched: list.length,
        ...(hiddenHits.length ? { privateNotesWithTheWordInTheirTitle: hiddenHits.slice(0, 10) } : {}),
      };
    },

    /** Lines matching a regular expression, in notes that are not private. */
    grep(pattern, o = {}) {
      let re;
      try {
        re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), o.ignoreCase === false ? "u" : "iu");
      } catch (e) {
        throw new Error(`grep: "${pattern}" is not a regular expression (${e.message}); escape special characters or pass plain words to notes.find`);
      }
      const s = load();
      const list = pool(s, o, todayOf(o.today));
      const max = Math.max(1, Math.min(Number(o.max ?? 40), 200));
      const started = Date.now();
      const hits = [];
      let total = 0;
      for (const n of list) {
        let text;
        try {
          text = fs.readFileSync(path.join(root, n.rel), "utf8");
        } catch {
          continue;
        }
        const lines = safeLines(text.split(/\r?\n/));
        for (let i = n.fmEnd; i < lines.length; i++) {
          re.lastIndex = 0;
          if (!re.test(lines[i].slice(0, 2000))) continue;
          total++;
          if (hits.length < max) hits.push({ path: n.rel, line: i + 1, date: n.day, heading: headingAt(n, i + 1), text: clip(lines[i].trim()) });
        }
      }
      note("grep", re.source, started, total);
      return { hits, total, complete: total <= max, searched: list.length };
    },

    /** One note by title, alias, file name or path, with its text. */
    note(name, o = {}) {
      if (!cleanName(name)) throw new Error('note needs a name: a title, an alias, a file name or a path, for example notes.note("WATCH-12")');
      const s = load();
      const r = resolve(s, name);
      if (!r) return { found: false, name: String(name), near: near(s, name), hint: "notes.find(words) searches titles and text" };
      const n = r.note;
      const others = r.others.filter((x) => !x.private).slice(0, 8).map((x) => x.rel);
      if (n.private) return { found: true, private: true, title: n.title, matchedBy: r.how, why: `the note is private (front matter private: true, or a tag of ${privateTags.join(", ")}): it is named, never quoted`, ...(others.length ? { alsoMatched: others } : {}) };
      const lines = readLines(n);
      if (!lines) return { found: false, name: String(name), path: n.rel, error: "the file could not be read" };
      let from = Math.max(1, Number(o.from ?? 1));
      let to = Number(o.to ?? 0) || lines.length;
      let section = null;
      if (o.heading) {
        const want = String(o.heading).toLowerCase();
        const h = n.headings.find((x) => x.x.toLowerCase() === want) ?? n.headings.find((x) => x.x.toLowerCase().includes(want));
        if (!h) return { found: true, path: n.rel, title: n.title, matchedBy: r.how, heading: null, error: `no heading "${o.heading}"`, headings: n.headings.map((x) => x.x) };
        const next = n.headings.find((x) => x.l > h.l && x.v <= h.v);
        from = h.l;
        to = next ? next.l - 1 : lines.length;
        section = h.x;
      }
      const maxLines = Math.max(1, Math.min(Number(o.max ?? 200), 400));
      to = Math.min(to, lines.length, from + maxLines - 1);
      let text = safeLines(lines.slice(from - 1, to)).map((l, i) => `${from + i}\t${clip(l, 400)}`).join("\n");
      const cut = text.length > 14_000;
      if (cut) text = text.slice(0, 14_000);
      const g = graph(s);
      return {
        found: true,
        path: n.rel,
        title: n.title,
        matchedBy: r.how,
        ...(others.length ? { alsoMatched: others } : {}),
        date: n.day,
        dateFrom: n.dayFrom,
        modified: n.modified,
        ...(n.aliases.length ? { aliases: n.aliases } : {}),
        ...(n.tags.length ? { tags: n.tags } : {}),
        ...(Object.keys(n.props).length ? { properties: n.props } : {}),
        words: n.words,
        headings: n.headings.slice(0, 40).map((h) => ({ line: h.l, level: h.v, text: h.x })),
        tasks: { open: n.tasks.filter((t) => t.s === " ").length, done: n.tasks.filter((t) => t.s === "x").length },
        links: { out: (g.out.get(n.rel) ?? []).length, in: (g.inbound.get(n.rel) ?? []).length },
        ...(section ? { section } : {}),
        lines: lines.length,
        from,
        to,
        ...(to < lines.length && !section ? { more: `lines ${to + 1} to ${lines.length}: notes.note(name, { from: ${to + 1} })` } : {}),
        ...(cut ? { clipped: true } : {}),
        text,
      };
    },

    /** The notes that link to a note, with the line each link sits on. */
    backlinks(name, o = {}) {
      const s = load();
      const r = resolve(s, name);
      if (!r) return { found: false, name: String(name), near: near(s, name) };
      if (r.note.private) return { found: true, private: true, title: r.note.title };
      const max = Math.max(1, Math.min(Number(o.max ?? 40), 200));
      const all = graph(s).inbound.get(r.note.rel) ?? [];
      const open = all.filter((b) => !b.from.private);
      const cache = new Map();
      const backlinks = open.slice(0, max).map((b) => {
        if (!cache.has(b.from.rel)) cache.set(b.from.rel, readLines(b.from) ?? []);
        return { ...row(b.from), line: b.link.l, heading: headingAt(b.from, b.link.l), ...(b.link.e ? { embed: true } : {}), text: clip(safe((cache.get(b.from.rel)[b.link.l - 1] ?? "").trim())) };
      });
      const hidden = [...new Set(all.filter((b) => b.from.private).map((b) => b.from.title))];
      return { found: true, note: row(r.note), matchedBy: r.how, backlinks, total: open.length, ...(open.length > max ? { leftOut: open.length - max } : {}), ...(hidden.length ? { fromPrivateNotes: hidden } : {}) };
    },

    /** What a note links to, with the line each link sits on; `resolved: null` is a link to a note that does not exist. */
    links(name, o = {}) {
      const s = load();
      const r = resolve(s, name);
      if (!r) return { found: false, name: String(name), near: near(s, name) };
      if (r.note.private) return { found: true, private: true, title: r.note.title };
      const max = Math.max(1, Math.min(Number(o.max ?? 60), 200));
      const mine = graph(s).out.get(r.note.rel) ?? [];
      const lines = mine.length ? readLines(r.note) ?? [] : [];
      const out = mine.slice(0, max).map(({ link, to }) => ({
        line: link.l,
        target: link.t,
        resolved: to ? (to.private ? null : to.rel) : null,
        ...(to?.private ? { private: true, title: to.title } : {}),
        ...(link.h ? { heading: link.h } : {}),
        ...(link.a ? { shownAs: link.a } : {}),
        ...(link.e ? { embed: true } : {}),
        text: clip(safe((lines[link.l - 1] ?? "").trim())),
      }));
      return { found: true, note: row(r.note), matchedBy: r.how, links: out, total: mine.length, unresolved: [...new Set(mine.filter((x) => !x.to).map((x) => x.link.t))], ...(mine.length > max ? { leftOut: mine.length - max } : {}) };
    },

    /** Every tag with the number of notes that carry it. A nested tag a/b also counts for a. */
    tags(o = {}) {
      const s = load();
      const counts = new Map();
      for (const n of s.open) {
        const seen = new Set();
        for (const t of n.tags) {
          const parts = t.split("/");
          for (let i = 1; i <= parts.length; i++) seen.add(parts.slice(0, i).join("/"));
        }
        for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const all = [...counts].map(([tag, notes]) => ({ tag, notes })).sort((a, b) => b.notes - a.notes || (a.tag < b.tag ? -1 : 1));
      const max = Math.max(1, Math.min(Number(o.max ?? 60), 500));
      return { tags: all.slice(0, max), total: all.length, ...(all.length > max ? { leftOut: all.length - max } : {}) };
    },

    /** The notes that carry a tag (or a tag nested under it), newest first. */
    tagged(tag, o = {}) {
      const t = String(tag ?? "").replace(/^#/, "").toLowerCase().trim();
      if (!t) throw new Error('tagged needs a tag, for example notes.tagged("case/open")');
      const s = load();
      const hit = (n) => n.tags.some((x) => x === t || x.startsWith(`${t}/`));
      const list = s.open.filter(hit).sort((a, b) => (a.day < b.day ? 1 : -1));
      const max = Math.max(1, Math.min(Number(o.max ?? 50), 300));
      const hidden = s.hidden.filter(hit).length;
      const have = list.length ? undefined : api.tags({ max: 500 }).tags.filter((x) => x.tag.includes(t) || t.includes(x.tag)).map((x) => x.tag).slice(0, 10);
      return {
        tag: t,
        notes: list.slice(0, max).map((n) => ({ ...row(n), tags: n.tags.filter((x) => x === t || x.startsWith(`${t}/`)) })),
        total: list.length,
        ...(list.length > max ? { leftOut: list.length - max } : {}),
        ...(hidden ? { privateNotes: hidden } : {}),
        ...(have ? { near: have } : {}),
      };
    },

    /** Tasks: `- [ ]`, `- [x]` and Logseq TODO and DONE blocks, with due dates. Overdue first. */
    tasks(o = {}) {
      const today = todayOf(o.today);
      const s = load();
      let list = s.open;
      let matchedBy;
      if (o.note) {
        const r = resolve(s, o.note);
        if (!r) return { found: false, note: String(o.note), near: near(s, o.note), tasks: [], total: 0 };
        if (r.note.private) return { found: true, private: true, title: r.note.title, tasks: [], total: 0 };
        list = [r.note];
        matchedBy = r.how;
      }
      const tag = o.tag ? String(o.tag).replace(/^#/, "").toLowerCase() : null;
      const hasTag = (tags) => tags.some((x) => x === tag || x.startsWith(`${tag}/`));
      let all = [];
      for (const n of list) {
        for (const t of n.tasks) {
          if (o.open === true && t.s !== " ") continue;
          if (o.open === false && t.s !== "x") continue;
          if (tag && !hasTag(t.g ?? []) && !hasTag(n.tags)) continue;
          all.push({ n, t });
        }
      }
      if (o.due != null && o.due !== "any") {
        const d = o.due;
        const week = addDays(today, 7);
        all = all.filter(({ t }) => {
          if (d === "none") return !t.d;
          if (!t.d) return false;
          if (d === true || d === "dated") return true;
          if (d === "overdue") return t.s === " " && t.d < today;
          if (d === "today") return t.d === today;
          if (d === "week") return t.d <= week;
          if (typeof d === "object") return (!d.after || t.d >= when(d.after, today)) && (!d.before || t.d <= when(d.before, today));
          return t.d <= when(d, today); // a date: due on or before it
        });
      }
      const rank = ({ t }) => (t.s !== " " ? 3 : !t.d ? 2 : t.d < today ? 0 : 1);
      all.sort((a, b) => rank(a) - rank(b) || (a.t.d ?? "9") .localeCompare(b.t.d ?? "9") || (a.n.day < b.n.day ? 1 : a.n.day > b.n.day ? -1 : 0) || a.t.l - b.t.l);
      const max = Math.max(1, Math.min(Number(o.max ?? 60), 300));
      const open = all.filter((x) => x.t.s === " ");
      return {
        today,
        ...(matchedBy ? { note: row(list[0]), matchedBy } : {}),
        tasks: all.slice(0, max).map(({ n, t }) => ({
          path: n.rel,
          line: t.l,
          text: safe(t.x),
          done: t.s === "x",
          ...(t.s === "-" ? { cancelled: true } : {}),
          ...(t.d ? { due: t.d } : {}),
          ...(t.s === " " && t.d && t.d < today ? { overdue: true } : {}),
          ...(t.c ? { scheduled: t.c } : {}),
          ...(t.n ? { doneOn: t.n } : {}),
          ...(t.g ? { tags: t.g } : {}),
          heading: headingAt(n, t.l),
          noteDate: n.day,
        })),
        total: all.length,
        open: open.length,
        overdue: open.filter((x) => x.t.d && x.t.d < today).length,
        done: all.filter((x) => x.t.s === "x").length,
        ...(all.length > max ? { leftOut: all.length - max } : {}),
      };
    },

    /** Notes created or changed since a time, newest first. */
    recent(o = {}) {
      const today = todayOf(o.today);
      const since = when(o.since ?? "7d", today);
      const until = o.until ? when(o.until, today) : today;
      const s = load();
      const inWin = (d) => d >= since && d <= until;
      const rows = [];
      for (const n of s.open) {
        const made = inWin(n.created);
        const changed = !o.created && inWin(n.modified) && n.modified !== n.created;
        if (!made && !changed) continue;
        const day = changed && (!made || n.modified > n.created) ? n.modified : n.created;
        const fromFile = day === n.modified && changed ? n.modifiedFrom === "file time" : n.dayFrom === "file time";
        rows.push({ path: n.rel, title: n.title, day, what: made && day === n.created ? "created" : "changed", ...(made && changed ? { created: n.created } : {}), ...(fromFile ? { dateFrom: "file time" } : {}), words: n.words, ...(n.tags.length ? { tags: n.tags.slice(0, 6) } : {}) });
      }
      rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.path < b.path ? -1 : 1));
      const max = Math.max(1, Math.min(Number(o.max ?? 50), 300));
      const hidden = s.hidden.filter((n) => inWin(n.created) || (!o.created && inWin(n.modified))).length;
      return { since, until, notes: rows.slice(0, max), total: rows.length, ...(rows.length > max ? { leftOut: rows.length - max } : {}), ...(hidden ? { privateNotes: hidden } : {}) };
    },

    /** A day's daily note. `date` is a date, "today" or "yesterday". */
    daily(date, o = {}) {
      const today = todayOf(o.today);
      const day = when(date ?? "today", today);
      const s = load();
      const n = s.notes.find((x) => x.dailyDay === day) ?? s.notes.find((x) => !s.notes.some((y) => y.dailyDay) && dateIn(x.name) === day && x.name.length <= 12);
      const expected = s.daily.pathOf(day);
      if (!n) {
        const days = s.notes.filter((x) => x.dailyDay).map((x) => x.dailyDay).sort();
        return { date: day, weekday: DOW[weekday(day)], exists: false, expectedAt: expected, pattern: s.daily.pattern, patternFrom: s.daily.from, nearest: { before: days.filter((d) => d < day).at(-1) ?? null, after: days.find((d) => d > day) ?? null } };
      }
      if (n.private) return { date: day, exists: true, private: true, title: n.title };
      const lines = readLines(n) ?? [];
      const max = Math.max(1, Math.min(Number(o.max ?? 200), 400));
      return {
        date: day,
        weekday: DOW[weekday(day)],
        exists: true,
        path: n.rel,
        words: n.words,
        ...(n.tags.length ? { tags: n.tags } : {}),
        tasks: n.tasks.map((t) => ({ line: t.l, text: safe(t.x), done: t.s === "x", ...(t.d ? { due: t.d } : {}) })),
        links: [...new Set(n.links.map((k) => k.t))].slice(0, 30),
        lines: lines.length,
        ...(lines.length > max ? { more: `lines ${max + 1} to ${lines.length}: notes.note("${n.rel}", { from: ${max + 1} })` } : {}),
        text: safeLines(lines.slice(0, max)).map((l, i) => `${i + 1}\t${clip(l, 400)}`).join("\n").slice(0, 14_000),
      };
    },

    /** The daily notes in a range, oldest first, without their text. */
    dailies(o = {}) {
      const today = todayOf(o.today);
      const since = when(o.since ?? "7d", today);
      const until = o.until ? when(o.until, today) : today;
      const s = load();
      const days = s.notes.filter((n) => n.dailyDay && n.dailyDay >= since && n.dailyDay <= until).sort((a, b) => (a.dailyDay < b.dailyDay ? -1 : 1));
      const max = Math.max(1, Math.min(Number(o.max ?? 62), 400));
      return {
        since,
        until,
        pattern: s.daily.pattern,
        days: days.slice(-max).map((n) => (n.private ? { date: n.dailyDay, private: true } : { date: n.dailyDay, weekday: DOW[weekday(n.dailyDay)], path: n.rel, words: n.words, headings: n.headings.slice(0, 8).map((h) => h.x), tasksOpen: n.tasks.filter((t) => t.s === " ").length, tasksDone: n.tasks.filter((t) => t.s === "x").length, links: [...new Set(n.links.map((k) => k.t))].slice(0, 12) })),
        total: days.length,
        ...(days.length > max ? { leftOut: days.length - max } : {}),
      };
    },

    /** Links to notes that do not exist, most wanted first. */
    unresolved(o = {}) {
      const s = load();
      const by = new Map();
      for (const u of graph(s).unresolved) {
        if (u.from.private) continue;
        const key = u.link.t.toLowerCase();
        const e = by.get(key) ?? { target: u.link.t, count: 0, from: [] };
        e.count++;
        if (e.from.length < 5) e.from.push({ path: u.from.rel, line: u.link.l });
        by.set(key, e);
      }
      const all = [...by.values()].sort((a, b) => b.count - a.count || (a.target < b.target ? -1 : 1));
      const max = Math.max(1, Math.min(Number(o.max ?? 40), 300));
      return { unresolved: all.slice(0, max), total: all.length, ...(all.length > max ? { leftOut: all.length - max } : {}) };
    },

    /** Notes nothing links to. Daily notes are left out: nothing links to most of them by design. */
    orphans(o = {}) {
      const s = load();
      const g = graph(s);
      const list = s.open.filter((n) => !n.dailyDay && !(g.inbound.get(n.rel) ?? []).length).sort((a, b) => (a.day < b.day ? 1 : -1));
      const max = Math.max(1, Math.min(Number(o.max ?? 40), 300));
      return { orphans: list.slice(0, max).map((n) => ({ ...row(n), linksOut: (g.out.get(n.rel) ?? []).filter((x) => x.to).length })), total: list.length, ...(list.length > max ? { leftOut: list.length - max } : {}) };
    },

    /** The notes most linked to. */
    hubs(o = {}) {
      const s = load();
      const g = graph(s);
      const max = Math.max(1, Math.min(Number(o.max ?? 10), 100));
      return s.open
        .map((n) => ({ n, k: new Set((g.inbound.get(n.rel) ?? []).map((b) => b.from.rel)).size }))
        .filter((x) => x.k)
        .sort((a, b) => b.k - a.k || (a.n.rel < b.n.rel ? -1 : 1))
        .slice(0, max)
        .map((x) => ({ path: x.n.rel, title: x.n.title, linkedFrom: x.k }));
    },

    /** Decisions: "Decision" headings, lines that say "decided" or "we will", and decision records, each with the reason lines near it. */
    decisions(topic, o = {}) {
      const q = tokens(topic ?? "");
      const today = todayOf(o.today);
      const s = load();
      const list = pool(s, o, today);
      const started = Date.now();
      const found = [];
      for (const n of list) {
        let text;
        try {
          text = fs.readFileSync(path.join(root, n.rel), "utf8");
        } catch {
          continue;
        }
        text = masked(text);
        const adr = ADR_PATH.test(n.rel) || /^adr\b/i.test(n.title);
        const before = found.length;
        if (!adr && !DECISION_LINE.test(text) && !n.headings.some((h) => DECISION_HEAD.test(h.x))) continue;
        const low = text.toLowerCase();
        const head = `${n.name} ${n.title} ${n.aliases.join(" ")} ${n.tags.join(" ")}`.toLowerCase();
        if (q.length && !q.every((w) => countWord(low, w, 1) || countWord(head, w, 1))) continue;
        const lines = text.split(/\r?\n/);
        const sectionEnd = (h) => (n.headings.find((x) => x.l > h.l && x.v <= h.v)?.l ?? lines.length + 1) - 1;
        const body = (from, to, max) => {
          const out = [];
          for (let i = from; i <= to && out.length < max; i++) if (lines[i - 1]?.trim() && !/^\s*(```|~~~)/.test(lines[i - 1])) out.push({ line: i, text: clip(safe(lines[i - 1].trim())) });
          return out;
        };
        const covered = [];
        const add = (line, heading, decision, reasons) => {
          const near = `${decision.map((d) => d.text).join(" ")} ${reasons.map((r) => r.text).join(" ")} ${heading ?? ""}`.toLowerCase();
          const onIt = q.filter((w) => countWord(near, w, 1)).length;
          const inHead = q.filter((w) => countWord(head, w, 1)).length;
          found.push({ n, line, heading, decision, reasons, rank: q.length ? onIt * 3 + inHead * 2 + (adr ? 1 : 0) : 0, on: q.length ? (onIt === q.length ? "the decision" : onIt || inHead ? "the decision and the note" : "the note") : undefined });
        };
        for (const h of n.headings) {
          if (!DECISION_HEAD.test(h.x)) continue;
          const end = sectionEnd(h);
          covered.push([h.l, end]);
          const decision = body(h.l + 1, end, 4);
          if (!decision.length) continue;
          const reasons = [];
          for (let i = h.l + 1; i <= end && reasons.length < 3; i++) if (REASON.test(lines[i - 1] ?? "") && !decision.some((d) => d.line === i)) reasons.push({ line: i, text: clip(safe(lines[i - 1].trim())) });
          for (const r of n.headings) if (r !== h && REASON_HEAD.test(r.x) && reasons.length < 5) reasons.push(...body(r.l + 1, sectionEnd(r), 2).map((x) => ({ ...x, under: r.x })));
          add(h.l, h.x, decision, reasons.slice(0, 5));
        }
        let fence = false;
        for (let i = n.fmEnd; i < lines.length; i++) {
          if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
          if (fence || !DECISION_LINE.test(lines[i]) || /^\s*#{1,6}\s/.test(lines[i])) continue;
          if (covered.some(([a, b]) => i + 1 >= a && i + 1 <= b)) continue;
          const reasons = [];
          for (let j = Math.max(n.fmEnd, i - 2); j <= Math.min(lines.length - 1, i + 5) && reasons.length < 3; j++) if (j !== i && REASON.test(lines[j]) && !/^\s*#{1,6}\s/.test(lines[j])) reasons.push({ line: j + 1, text: clip(safe(lines[j].trim())) });
          add(i + 1, headingAt(n, i + 1), [{ line: i + 1, text: clip(safe(lines[i].trim())) }], reasons);
        }
        if (adr && found.length === before) {
          const why = n.headings.filter((r) => REASON_HEAD.test(r.x)).flatMap((r) => body(r.l + 1, sectionEnd(r), 2).map((x) => ({ ...x, under: r.x })));
          const lead = body(n.fmEnd + 1, lines.length, 3).filter((x) => !/^#{1,6}\s/.test(x.text));
          if (lead.length) add(lead[0].line, null, lead, why.slice(0, 4));
        }
      }
      note("decisions", q.join(" ") || "(all)", started, found.length);
      found.sort((a, b) => b.rank - a.rank || (a.n.day < b.n.day ? 1 : a.n.day > b.n.day ? -1 : 0) || a.line - b.line);
      const max = Math.max(1, Math.min(Number(o.max ?? 10), 40));
      return {
        topic: q,
        decisions: found.slice(0, max).map((f) => ({
          path: f.n.rel,
          title: f.n.title,
          date: f.n.day,
          ...(f.n.dayFrom === "file time" ? { dateFrom: "file time" } : {}),
          ...(f.n.props.status ? { status: f.n.props.status } : {}),
          line: f.line,
          heading: f.heading,
          decision: f.decision.map((d) => d.text).join(" / "),
          reasons: f.reasons,
          ...(f.on ? { topicIsIn: f.on } : {}),
        })),
        total: found.length,
        ...(found.length > max ? { leftOut: found.length - max } : {}),
        searched: list.length,
      };
    },
  };

  // ---- changing notes: only in an ask that asked for a change ----

  /** A file as lines with each line's own ending kept, so an edit changes nothing it does not touch. */
  function openDoc(rel) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const parts = text.split(/(\r?\n)/);
    const lines = [];
    const seps = [];
    for (let i = 0; i < parts.length; i += 2) {
      lines.push(parts[i]);
      seps.push(parts[i + 1] ?? "");
    }
    const eol = seps.find(Boolean) ?? "\n";
    return { rel, lines, seps, eol, parsed: parseNote(text) };
  }
  const saveDoc = (doc) => {
    const started = Date.now();
    const text = doc.lines.map((l, i) => l + doc.seps[i]).join("");
    fs.writeFileSync(path.join(root, doc.rel), text);
    note("write", doc.rel, started, text.length);
    stale();
  };
  /** Put `added` after 0-based line `k` (-1 for the top). Returns the 1-based line of the first added line. */
  function insertAfter(doc, k, added) {
    const lastIsEmpty = doc.lines.length > 1 && doc.lines.at(-1) === "" && doc.seps.at(-1) === "";
    if (k >= doc.lines.length - 1 && lastIsEmpty) k = doc.lines.length - 2; // the file ends with a newline: stay before it
    if (k === doc.lines.length - 1) {
      // The file does not end with a newline: the old last line gets one, the new last line has none.
      doc.seps[k] = doc.eol;
      doc.lines.push(...added);
      doc.seps.push(...added.map((_, i) => (i === added.length - 1 ? "" : doc.eol)));
    } else {
      doc.lines.splice(k + 1, 0, ...added);
      doc.seps.splice(k + 1, 0, ...added.map(() => doc.eol));
    }
    return k + 2;
  }
  const isItem = (l) => /^\s*([-*+]|\d+[.)])\s/.test(l ?? "");
  const textLines = (text, what) => {
    const t = String(text ?? "").replace(/\s+$/, "");
    if (!t.trim()) throw new Error(`${what} needs the text to write`);
    if (t.length > 20_000) throw new Error(`${what}: the text is ${t.length} characters; at most 20000 in one call`);
    return t.split(/\r?\n/);
  };
  const target = (name, what) => {
    if (!cleanName(name)) throw new Error(`${what} needs the note's name: a title, an alias, a file name or a path`);
    const s = load();
    const r = resolve(s, name);
    if (!r) throw new Error(`no note "${name}"${near(s, name).length ? `; near: ${near(s, name).join(", ")}` : ""}. notes.create(name, text) makes one.`);
    refuseHidden(r.note, "edit");
    return r;
  };

  /** Where text goes: under a heading (made at the end when absent), or at the end of the note. */
  function place(doc, lines, under) {
    let made = null;
    let k;
    let added = [...lines];
    if (under) {
      const want = String(under).replace(/^#+\s*/, "").trim().toLowerCase();
      const hs = doc.parsed.hd ?? [];
      const h = hs.find((x) => x.x.toLowerCase() === want) ?? hs.find((x) => x.x.toLowerCase().includes(want));
      if (h) {
        const next = hs.find((x) => x.l > h.l && x.v <= h.v);
        let end = (next ? next.l - 1 : doc.lines.length) - 1; // 0-based last line of the section
        while (end > h.l - 1 && !doc.lines[end].trim()) end--;
        k = end;
        if (end === h.l - 1 || !(isItem(doc.lines[end]) && isItem(added[0]))) added.unshift("");
        if (next && end + 1 === next.l - 1) added.push(""); // the next heading follows at once: keep a blank line before it
        made = false;
        under = h.x;
      } else {
        made = true;
        under = String(under).replace(/^#+\s*/, "").trim();
        added = [`## ${under}`, "", ...added];
      }
    }
    if (k == null) {
      k = doc.lines.length - 1;
      while (k >= 0 && !doc.lines[k].trim()) k--;
      const blankNeeded = k >= 0 && (made || !(isItem(doc.lines[k]) && isItem(added[0])));
      if (blankNeeded) added.unshift("");
      // Blank lines already at the end stay; the text goes after the last line that has text.
    }
    const at = insertAfter(doc, k, added);
    const firstText = at + added.findIndex((l) => l.trim() && !(made && /^## /.test(l)));
    return { line: firstText, under: under ?? null, headingMade: made === true };
  }

  const changed = (rel, r, extra) => {
    const fresh = fs.readFileSync(path.join(root, rel), "utf8").split(/\r?\n/);
    const from = Math.max(1, extra.line - 1);
    return { changed: true, path: rel, ...(r ? { matchedBy: r.how } : {}), ...extra, now: safeLines(fresh.slice(from - 1, extra.line + (extra.added ?? 1))).map((l, i) => `${from + i}\t${clip(l, 300)}`).join("\n") };
  };

  const acting = {
    /** Add text to a note: under a heading when given (made when absent), else at the end. */
    append(name, text, o = {}) {
      const lines = textLines(text, "append");
      const r = target(name, "append");
      const doc = openDoc(r.note.rel);
      const p = place(doc, lines, o.under);
      saveDoc(doc);
      return changed(r.note.rel, r, { ...p, added: lines.length });
    },

    /** Make a new note. Never overwrites: an existing note is a refusal. */
    create(name, text = "", o = {}) {
      const raw = String(name ?? "").trim().replace(/\\/g, "/");
      if (!raw) throw new Error("create needs the new note's name");
      const folder = String(o.folder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      let rel = path.posix.normalize(`${folder ? `${folder}/` : ""}${raw}`);
      if (!NOTE_EXT.has(path.posix.extname(rel).toLowerCase())) rel += ".md";
      const segments = rel.split("/");
      if (rel.startsWith("..") || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`create: "${name}" is outside the notes folder; give a name or a path inside it`);
      if (segments.some((x) => x.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(x))) throw new Error(`create: "${rel}" has a hidden folder or a character a file name cannot hold (< > : " | ? *)`);
      if (segments.some(credNamed)) throw new Error(`create: "${rel}" is named like a credential file, and this kit never reads those; choose another name`);
      const s = load();
      const full = path.join(root, rel);
      const same = s.notes.find((n) => n.low === rel.toLowerCase());
      if (same || fs.existsSync(full)) throw new Error(`create: ${same?.rel ?? rel} already exists and is not overwritten; use notes.append("${same?.rel ?? rel}", text)`);
      const tags = listOf(o.tags, /[,\s]+/).map((t) => t.replace(/^#/, ""));
      const body = String(text ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
      const content = `${tags.length ? `---\ntags:\n${tags.map((t) => `  - ${t}`).join("\n")}\n---\n` : ""}${body}${body ? "\n" : ""}`;
      const started = Date.now();
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, { flag: "wx" });
      note("write", rel, started, content.length);
      stale();
      const twins = s.notes.filter((n) => n.name.toLowerCase() === path.posix.basename(rel, path.posix.extname(rel)).toLowerCase()).map((n) => n.rel);
      return { changed: true, created: true, path: rel, lines: content.split("\n").length - 1, ...(tags.length ? { tags } : {}), ...(twins.length ? { sameNameAs: twins, note: "a [[wiki link]] by name alone may resolve to the other note" } : {}) };
    },

    /** Add an open task to a note, in the note's own task style. */
    task(name, text, o = {}) {
      const body = textLines(text, "task").join(" ").replace(/^\s*[-*+]\s+(\[.\]\s+|TODO\s+)?/, "");
      const r = target(name, "task");
      const doc = openDoc(r.note.rel);
      const q = doc.parsed.q ?? [];
      const logseq = q.length > 0 && q.every((t) => t.k);
      const due = o.due ? when(o.due, todayOf(o.today)) : null;
      const usesField = q.some((t) => /\bdue::/i.test(t.x));
      const lines = logseq ? [`- TODO ${body}`, ...(due ? [`  DEADLINE: <${due} ${DOW[weekday(due)].slice(0, 3)}>`] : [])] : [`- [ ] ${body}${due ? (usesField ? ` [due:: ${due}]` : ` 📅 ${due}`) : ""}`];
      const under = o.under ?? (doc.parsed.hd ?? []).find((h) => TASK_HEAD.test(h.x))?.x;
      const p = place(doc, lines, under);
      saveDoc(doc);
      return changed(r.note.rel, r, { ...p, added: lines.length, task: lines[0] });
    },

    /** Tick one open task: by its line number, or by its text (exact, then substring). Several matches change nothing. */
    check(name, ref) {
      if (ref == null || ref === "") throw new Error("check needs the task: its line number or words from its text");
      const r = target(name, "check");
      const doc = openDoc(r.note.rel);
      const all = doc.parsed.q ?? [];
      const open = all.filter((t) => t.s === " ");
      const show = (list) => list.slice(0, 12).map((t) => ({ line: t.l, text: safe(t.x) }));
      let hit;
      let how;
      if (typeof ref === "number" || /^\d+$/.test(String(ref).trim())) {
        const t = all.find((x) => x.l === Number(ref));
        if (!t) return { changed: false, path: r.note.rel, why: `line ${ref} is not a task`, openTasks: show(open) };
        if (t.s !== " ") return { changed: false, path: r.note.rel, why: `the task on line ${ref} is already ${t.s === "x" ? "done" : "cancelled"}`, task: safe(t.x) };
        hit = t;
        how = "line";
      } else {
        const want = String(ref).trim().toLowerCase();
        let hits = open.filter((t) => t.x.toLowerCase() === want);
        how = "exact text";
        if (!hits.length) {
          hits = open.filter((t) => t.x.toLowerCase().includes(want));
          how = "substring";
        }
        if (!hits.length) {
          const done = all.find((t) => t.s === "x" && t.x.toLowerCase().includes(want));
          return { changed: false, path: r.note.rel, why: done ? `already done: line ${done.l}` : `no open task holds "${ref}"`, openTasks: show(open) };
        }
        if (hits.length > 1) return { changed: false, path: r.note.rel, why: `${hits.length} open tasks hold "${ref}": name one by its line`, candidates: show(hits) };
        hit = hits[0];
      }
      const i = hit.l - 1;
      const before = doc.lines[i];
      doc.lines[i] = hit.k ? before.replace(/^(\s*[-*]\s+)(TODO|DOING|NOW|LATER|WAITING|IN-PROGRESS)\b/, "$1DONE") : before.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[).(\])/, "$1x$2");
      if (doc.lines[i] === before) return { changed: false, path: r.note.rel, why: `line ${hit.l} could not be ticked as written`, text: safe(before) };
      saveDoc(doc);
      return changed(r.note.rel, r, { line: hit.l, added: 0, matchedTaskBy: how, task: safe(hit.x) });
    },

    /** Add a line with the time to today's daily note, making the note when it is not there. */
    capture(text, o = {}) {
      const lines = textLines(text, "capture");
      const today = todayOf(o.today);
      const now = new Date();
      const time = /^\d{1,2}:\d\d$/.test(String(o.time ?? "")) ? String(o.time).padStart(5, "0") : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const s = load();
      const have = s.notes.find((n) => n.dailyDay === today);
      if (have) refuseHidden(have, "edit");
      const rel = have?.rel ?? s.daily.pathOf(today);
      const entry = [`- ${time} ${lines[0].replace(/^\s*[-*+]\s+/, "")}`, ...lines.slice(1).map((l) => `  ${l}`)];
      if (!have) {
        if (rel.split("/").some((x) => x.startsWith(".") || credNamed(x))) throw new Error(`capture: the daily note path ${rel} is hidden or named like a credential file; set NOTES_DAILY`);
        const started = Date.now();
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), `${entry.join("\n")}\n`, { flag: "wx" });
        note("write", rel, started, entry.join("\n").length);
        stale();
        return changed(rel, null, { created: true, date: today, line: 1, added: entry.length });
      }
      const doc = openDoc(rel);
      const p = place(doc, entry, o.under);
      saveDoc(doc);
      return changed(rel, null, { date: today, ...p, added: entry.length });
    },
  };

  for (const name of Object.keys(acting)) {
    api[name] = act
      ? acting[name]
      : () => {
          throw new Error(offInThisAsk(`notes.${name}`));
        };
  }

  /** The same functions over another notes folder, relative to the caller's folder. */
  api.at = (dir) => {
    if (!dir || typeof dir !== "string") throw new Error("at needs a folder");
    const other = path.resolve(workdir, expand(dir));
    return other === root ? api : makeVault({ root: other, settings: { ...settings, NOTES_DAILY: "" }, push, act, workdir });
  };
  return api;
}

export function make({ settings = {}, push = () => {}, act = false, cwd } = {}) {
  const workdir = path.resolve(expand(settings.WORKDIR || cwd || process.cwd()));
  const dir = String(settings.NOTES_DIR ?? "").trim();
  // With no NOTES_DIR the kit is not offered at all; a root that cannot exist makes every call say what to set.
  const root = dir ? path.resolve(workdir, expand(dir)) : path.join(workdir, "NOTES_DIR is not set");
  return makeVault({ root, settings, push, act: !!act, workdir });
}
