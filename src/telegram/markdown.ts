import { GrammyError } from "grammy";
import { TELEGRAM_MAX_MESSAGE } from "./limits";

// The agent emits CommonMark, but Telegram only understands its own restricted
// HTML (no headings/tables/lists, a handful of inline tags). Sending raw
// markdown with no parse_mode shows the literal `**`, `#`, backticks, etc.
// This module converts markdown to Telegram-safe HTML and splits it without
// breaking tags. Anything unsupported degrades to escaped plain text rather
// than producing invalid HTML (which Telegram would reject with a 400).

// Non-printable sentinels so protected code spans never collide with real text.
const CODE_OPEN = String.fromCharCode(0);
const CODE_CLOSE = String.fromCharCode(1);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function convertInline(text: string): string {
  // Protect inline code spans first so their contents are not re-formatted.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });

  s = escapeHtml(s);

  // Bold before italic so `**x**` is not mis-read as two italics.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>").replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");

  // Links: [text](url). `s` is already escaped, so the url is safe for the href.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`);

  // Restore protected code spans.
  return s.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_m, i: string) => codes[Number(i)]);
}

function convertLine(line: string): string {
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (heading) return `<b>${convertInline(heading[2])}</b>`;

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return "—"; // horizontal rule

  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${convertInline(bullet[2])}`;

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) return convertInline(quote[1]);

  return convertInline(line);
}

/** Convert a full markdown message to Telegram-safe HTML. */
export function mdToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*(```|~~~)/);
    if (fence) {
      const marker = fence[1];
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        code.push(lines[i]);
        i++;
      }
      // i now points at the closing fence (or past end); the for-loop's i++ skips it.
      out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    out.push(convertLine(lines[i]));
  }
  return out.join("\n");
}

/**
 * Split Telegram HTML into <=limit chunks on line boundaries, reopening a
 * `<pre>` block that would otherwise be split across the cut. Inline tags never
 * cross a line, so line-boundary splitting keeps them balanced.
 */
export function splitTelegramHtml(html: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (!html) return [];
  const parts: string[] = [];
  const lines = html.split("\n");
  let cur = "";
  let inPre = false;

  const nextPreState = (line: string): boolean => {
    const opens = (line.match(/<pre>/g) || []).length;
    const closes = (line.match(/<\/pre>/g) || []).length;
    if (opens > closes) return true;
    if (closes > opens) return false;
    return inPre;
  };

  for (const line of lines) {
    const prefix = cur ? `${cur}\n` : cur;
    const candidate = prefix + line;
    const closeLen = inPre ? "</pre>".length : 0;
    if (cur && candidate.length + closeLen > limit) {
      parts.push(inPre ? `${cur}\n</pre>` : cur);
      cur = inPre ? `<pre>${line}` : line;
    } else {
      cur = candidate;
    }
    inPre = nextPreState(line);
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Strip Telegram HTML back to readable plain text (fallback when a send is rejected). */
export function telegramHtmlToPlain(html: string): string {
  return html
    .replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1")
    .replace(/<\/?[a-z][^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** True when Telegram rejected a message because of bad HTML entities/tags. */
export function isTelegramHtmlParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /can't parse|unsupported start tag|can't find end|entities/i.test(err.description ?? "")
  );
}
