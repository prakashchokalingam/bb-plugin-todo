// Pure helpers for task titles. A title is plain text that may span several
// lines; links are derived for display only and never stored. Shared by the
// server (db.ts normalises on write) and the UI (editor + renderer).

export type TaskTextSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

/** Converts CRLF and lone CR to LF. Internal blank lines are kept. */
export function normalizeNewlines(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

/** Text boundary for a title: LF newlines, outer whitespace trimmed. */
export function normalizeTitle(raw: string): string {
  return normalizeNewlines(raw).trim();
}

/** First line of a title, for compact surfaces (breadcrumbs, toasts). */
export function firstLine(title: string): string {
  const line = normalizeNewlines(title).split("\n")[0] ?? "";
  return line.trim();
}

/** Full title on one line, for aria-labels and tooltips. */
export function singleLineLabel(title: string): string {
  return normalizeNewlines(title).replace(/\s*\n\s*/g, " ").trim();
}

export function isMultiline(title: string): boolean {
  return normalizeNewlines(title.trim()).includes("\n");
}

// A candidate starts at `http://`, `https://`, or `www.` and runs to the next
// whitespace or markup-ish character. The lookbehind keeps `awww.x` and
// `foo/http://x` from matching mid-word.
const URL_CANDIDATE = /(?<![A-Za-z0-9_@/.-])(?:https?:\/\/|www\.(?=[A-Za-z0-9]))[^\s<>"`]+/gi;

const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Drops sentence punctuation from the end of a candidate and keeps a closing
 * bracket only when the candidate holds its opening partner. */
function trimCandidate(candidate: string): string {
  let end = candidate.length;
  while (end > 0) {
    const ch = candidate[end - 1] as string;
    if (TRAILING_PUNCTUATION.has(ch)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener) {
      const body = candidate.slice(0, end);
      const opens = body.split(opener).length - 1;
      const closes = body.split(ch).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return candidate.slice(0, end);
}

/** Returns the safe href for a matched link text, or null when it is not a
 * valid HTTP or HTTPS URL. Only these two schemes can ever reach an anchor. */
function toHref(text: string): string | null {
  const href = /^www\./i.test(text) ? `https://${text}` : text;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return href;
  } catch {
    return null;
  }
}

/** Splits a title into plain-text and link segments. Concatenating every
 * segment's `text` always reproduces the input exactly. */
export function parseTaskText(title: string): TaskTextSegment[] {
  const segments: TaskTextSegment[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.type === "text") last.text += text;
    else segments.push({ type: "text", text });
  };

  for (const match of title.matchAll(URL_CANDIDATE)) {
    const start = match.index ?? 0;
    const text = trimCandidate(match[0]);
    const href = toHref(text);
    if (!href) continue;
    pushText(title.slice(cursor, start));
    segments.push({ type: "link", text, href });
    cursor = start + text.length;
  }
  pushText(title.slice(cursor));
  return segments;
}

export function hasLinks(title: string): boolean {
  return parseTaskText(title).some((s) => s.type === "link");
}

/** True when the title is one link and nothing else but whitespace. */
export function isUrlOnly(title: string): boolean {
  const segments = parseTaskText(title);
  const links = segments.filter((s) => s.type === "link");
  if (links.length !== 1) return false;
  return segments.every((s) => s.type === "link" || s.text.trim() === "");
}
