import type { WorkspacePrComment } from "../../contracts/git.ts";

/**
 * Turn a sanitized-away HTML `<table>` into a GFM table so a bot's status
 * matrix (Vercel, etc.) renders as a real table instead of a pile of cells.
 * Inline markup inside cells has already been folded to markdown by the time
 * this runs; unknown tags are stripped by the caller afterwards.
 */
function htmlTableToMarkdown(tableHtml: string): string {
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(
    (match) => match[1] ?? "",
  );
  const cellsFor = (row: string) =>
    [...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cell) =>
      (cell[1] ?? "")
        // Any tag still here wasn't folded by the inline passes; drop it so a
        // later newline replacement can't split the cell's markdown.
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim(),
    );
  const parsed = rows.map(cellsFor).filter((cells) => cells.length > 0);
  if (parsed.length === 0) return "\n";

  const width = Math.max(...parsed.map((cells) => cells.length));
  const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill("")];
  const toLine = (cells: string[]) => `| ${pad(cells).join(" | ")} |`;
  const [header, ...rest] = parsed;
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  return `\n\n${[toLine(header!), separator, ...rest.map(toLine)].join("\n")}\n\n`;
}

/**
 * Collapsed `<details>` sections a review bot adds for its own bookkeeping
 * (CodeRabbit's analysis chain and the scripts it ran, its prompt for AI
 * agents, learnings, a committable copy of the suggested diff). GitHub keeps
 * them folded away; markdown can't fold, so they are dropped rather than
 * printed in full above the finding.
 */
const NOISE_DETAILS =
  /analysis chain|static analysis|prompt for ai agents?|learnings|committable suggestion|review details|tools? used|script executed/i;

/**
 * Remove every `<details>` block whose `<summary>` matches `isNoise`,
 * honouring nesting so a block's inner `<details>` don't end it early.
 */
function dropDetails(html: string, isNoise: (summary: string) => boolean): string {
  const tag = /<(\/?)details\b[^>]*>/gi;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html))) {
    if (match[1]) continue; // a stray close tag outside any dropped block
    const start = match.index;
    const opened = start + match[0].length;
    const summary = /^\s*<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(html.slice(opened))?.[1] ?? "";
    if (!isNoise(summary.replace(/<[^>]+>/g, ""))) continue;
    // Walk to the matching close tag.
    let depth = 1;
    let end = html.length;
    while (depth > 0) {
      const next = tag.exec(html);
      if (!next) break;
      depth += next[1] ? -1 : 1;
      if (depth === 0) end = next.index + next[0].length;
    }
    out += html.slice(cursor, start);
    cursor = end;
    tag.lastIndex = end;
  }
  return out + html.slice(cursor);
}

/**
 * Code is literal: a diff that touches `<Tooltip>` must keep its tags. Fenced
 * blocks and inline code spans are set aside (as placeholders no pass below
 * matches) and put back once the HTML has been folded.
 */
function protectCode(text: string): { text: string; restore: (value: string) => string } {
  const saved: string[] = [];
  const hold = (code: string) => `\u0000${saved.push(code) - 1}\u0000`;
  const held = text
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*$/gm, (block) => hold(block))
    .replace(/`[^`\n]+`/g, (span) => hold(span));
  return {
    text: held,
    restore: (value) => value.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => saved[Number(i)]!),
  };
}

/** Inner text of a fragment: tags gone, whitespace trimmed. */
const innerText = (html: string) => html.replace(/<[^>]+>/g, "").trim();

/**
 * Review bots post HTML (`<h3>`, `<details>`, `<code>`), which the sanitized
 * markdown renderer drops. Fold the common tags into markdown so a comment
 * reads the way it does on GitHub, and strip the rest.
 */
export function commentToMarkdown(body: string): string {
  const code = protectCode(
    dropDetails(body.replace(/<!--[\s\S]*?-->/g, ""), (summary) => NOISE_DETAILS.test(summary)),
  );
  const markdown = code.text
    // `**<img> Minor**` would leave `** Minor**`, which isn't bold (CommonMark
    // won't open emphasis before a space); fold the tags out and trim first.
    .replace(/\*\*([^*\n]*<[^*\n]*?)\*\*/g, (_m, inner: string) => {
      const text = innerText(inner);
      return text ? `**${text}**` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => {
      return `\n${"#".repeat(Number(level))} ${text.trim()}\n`;
    })
    .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_m, inner: string) => {
      const text = innerText(inner);
      return text ? `\n**${text}**\n` : "\n";
    })
    .replace(/<\/?details[^>]*>/gi, "\n")
    .replace(
      /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, text: string) => {
        // Anchors wrapping only images/decorations carry no text; keep the URL
        // out of the markdown (an empty `[](url)` would just be link noise).
        return innerText(text) ? `[${text}](${href})` : "";
      },
    )
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => {
      const text = inner.trim();
      return text ? `**${text}**` : "";
    })
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "_$2_")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    // A status badge image immediately before a link with the same label is
    // redundant (e.g. Vercel's `![Ready](dot.svg) [Ready](url)`); drop the
    // image so the cell reads as one line instead of stacking the dot on top.
    .replace(
      /!\[([^\]]+)\]\([^)]*\)(\s*)\[([^\]]+)\]\(/g,
      (match, alt: string, gap: string, label: string) =>
        alt.trim().toLowerCase() === label.trim().toLowerCase() ? `${gap}[${label}](` : match,
    )
    .replace(/<table[^>]*>[\s\S]*?<\/table>/gi, (table) => htmlTableToMarkdown(table))
    // Block-only tags become line breaks. Inline tags (img, span, sup, …) are
    // left for the generic strip below — turning them into newlines would break
    // any markdown table row that embeds HTML in a cell.
    .replace(/<\/?(p|div|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|dl|dt|dd)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // Lines left holding only indentation would otherwise read as blank lines
    // that don't collapse below.
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return code.restore(markdown);
}

/**
 * Drop a bot's autogenerated appendix from a PR body — e.g. CodeRabbit's
 * `<!-- This is an auto-generated comment: … coderabbit.ai -->` block and
 * everything after it — so the Check tab shows the author's description only.
 */
export function stripAutogeneratedBody(body: string): string {
  return body.replace(/<!--[\s\S]*?auto-generated[\s\S]*?-->[\s\S]*$/i, "").trim();
}

/**
 * Drop a leading markdown heading from a PR body when it just repeats the PR
 * title, so a panel that shows the title doesn't print it twice.
 */
export function stripDuplicateTitle(body: string, title: string): string {
  const match = body.match(/^[ \t]*#{1,6}[ \t]+([^\n]+?)[ \t]*(?:\n|$)/);
  if (!match) return body;
  const normalize = (value: string) =>
    value
      .replace(/[*_`#>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  if (normalize(match[1]!) !== normalize(title)) return body;
  return body.slice((match.index ?? 0) + match[0].length).replace(/^\s+/, "");
}

/** First meaningful line of a comment body, one line, capped. */
export function commentPreview(body: string, max = 140): string {
  const cleaned = commentToMarkdown(body)
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, max);
}

export type CommentSeverity = "high" | "medium" | "low";

/** Inline review comments carry a `path`; general bot comments don't. */
export function isInlineComment(comment: Pick<WorkspacePrComment, "path">): boolean {
  return Boolean(comment.path);
}

/** The words and badges bots state a severity with, read as a label. */
const SEVERITY_LABELS: Array<{ level: CommentSeverity; pattern: RegExp }> = [
  { level: "high", pattern: /^(critical|blocker|high|p0)\b/i },
  { level: "medium", pattern: /^(major|medium|warning|p1)\b/i },
  { level: "low", pattern: /^(minor|low|trivial|nitpick|info|p[2-4])\b/i },
];

/** Fallback for comments with no label: keywords in the opening text. */
const SEVERITY_RULES: Array<{ level: CommentSeverity; pattern: RegExp }> = [
  { level: "high", pattern: /\b(critical|high|blocker|bugs?|security)\b|vulnerab/i },
  { level: "medium", pattern: /\b(warning|medium|major|rule violation)\b/i },
  { level: "low", pattern: /\b(nitpicks?|low|suggestions?|styles?|minor)\b/i },
];

function labelLevel(label: string): CommentSeverity | null {
  return SEVERITY_LABELS.find((rule) => rule.pattern.test(label))?.level ?? null;
}

/** Markdown images (`![P1 Badge](…)`) left in a line by a bot's badge. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * A bot's label line: only emphasized segments, split by `·` or `|`.
 * CodeRabbit writes `**Minor** · **Functional Correctness** · **Quick win**`
 * (formerly `_⚠️ Potential issue_ | _🟠 Major_`), Bugbot `**Medium Severity**`.
 * Returns each segment's words, or null when the line isn't one.
 */
function labelSegments(line: string): string[] | null {
  // Badge images are read separately; their alt text isn't a label word.
  const parts = line.replace(MARKDOWN_IMAGE, "").split(/\s+[·|]\s+/);
  const segments: string[] = [];
  for (const part of parts) {
    const match = /^(\*\*|_)(.+)\1$/.exec(part.trim());
    if (!match) return null;
    // Drop the emoji/glyph a bot puts before the word, and a "Severity" suffix.
    segments.push(
      match[2]!
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/\s+severity$/i, "")
        .trim(),
    );
  }
  // A lone bold line is a title unless its word is a severity.
  if (segments.length === 1 && !labelLevel(segments[0]!)) return null;
  return segments;
}

/** Inline text of a title: no badges, emphasis markers or extra spaces. */
function cleanTitle(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A review comment in the one shape every bot's finding fits. */
export interface CommentFinding {
  /** Normalized severity, for the mark; null when the bot states none. */
  severity: CommentSeverity | null;
  /** The bot's own word for it ("Minor", "P1"), for the tooltip. */
  severityLabel: string | null;
  /** One line; inline code is kept in backticks. */
  title: string;
  /** The explanation, minus the label line, title and status footer. */
  body: string;
  /** The bot marked it fixed by a later commit. */
  addressed: boolean;
}

/**
 * Read a bot comment as a finding. GitHub fixes only the envelope (author,
 * path, line); the body is free markdown, but CodeRabbit, Greptile, Codex and
 * Bugbot all write it the same way: a severity label or badge, a bold one-line
 * title, the explanation, then collapsed extras. Comments that don't follow it
 * fall back to their heading or first sentence as the title.
 */
export function commentFinding(comment: Pick<WorkspacePrComment, "body">): CommentFinding {
  const markdown = commentToMarkdown(comment.body);
  // Greptile's badge is an `<img alt="P1">` inside a link, which the folding
  // drops with the link; read it from the source.
  let severityLabel =
    /<img\b[^>]*\balt=["'](P[0-4])\b/i.exec(comment.body)?.[1] ??
    /!\[(P[0-4])\b[^\]]*\]\(/i.exec(markdown)?.[1] ??
    null;

  const lines = markdown.split("\n");
  let addressed = false;
  const kept = lines.filter((line) => {
    if (/^\s*✅\s*addressed in commit/i.test(line)) {
      addressed = true;
      return false;
    }
    return true;
  });

  const nextLine = (from: number) => {
    let index = from;
    while (index < kept.length && !kept[index]!.trim()) index += 1;
    return index;
  };

  let index = nextLine(0);
  const segments = index < kept.length ? labelSegments(kept[index]!.trim()) : null;
  if (segments) {
    severityLabel ??= segments.find((segment) => labelLevel(segment)) ?? null;
    kept.splice(index, 1);
    index = nextLine(index);
  }

  let title: string | null = null;
  const opening = (kept[index] ?? "").replace(MARKDOWN_IMAGE, "").trim();
  const bold = /^\*\*(.+)\*\*$/.exec(opening)?.[1];
  const heading = /^#{1,6}\s+(.+)$/.exec(opening)?.[1];
  if (bold ?? heading) {
    title = cleanTitle(bold ?? heading!);
    kept.splice(index, 1);
  }

  const body = kept.join("\n").trim();
  title ||= fallbackTitle(body);
  const severity = severityLabel
    ? labelLevel(severityLabel)
    : (SEVERITY_RULES.find((rule) => rule.pattern.test(markdown.slice(0, 280)))?.level ?? null);
  return { severity, severityLabel, title, body, addressed };
}

/** The first heading, else the first sentence, of a comment's markdown. */
function fallbackTitle(markdown: string): string {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.replace(/[*_`]/g, "").slice(0, 80);
  const firstLine =
    markdown
      .split("\n")
      .map((line) => line.trim())
      // Skip link-reference definitions (e.g. Vercel's `[vc]: #…` metadata),
      // which GitHub renders invisibly.
      .find((line) => line && !/^\[[^\]]+\]:\s*\S/.test(line)) ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return commentPreview(sentence, 80) || "Comment";
}

/** Severity of a bot comment: its stated label, else keywords up top. */
export function commentSeverity(comment: Pick<WorkspacePrComment, "body">): CommentSeverity | null {
  return commentFinding(comment).severity;
}

export const SEVERITY_RANK: Record<CommentSeverity, number> = { high: 3, medium: 2, low: 1 };

/** Highest severity across a group, for the bot's accordion header. */
export function highestSeverity(comments: WorkspacePrComment[]): CommentSeverity | null {
  let best: CommentSeverity | null = null;
  for (const comment of comments) {
    const level = commentSeverity(comment);
    if (level && (best === null || SEVERITY_RANK[level] > SEVERITY_RANK[best])) best = level;
  }
  return best;
}

/** Comments grouped by author, in the order authors first appear. */
export function groupCommentsByAuthor(
  comments: WorkspacePrComment[],
): Array<{ author: string; avatarUrl: string | null; comments: WorkspacePrComment[] }> {
  const groups = new Map<
    string,
    { author: string; avatarUrl: string | null; comments: WorkspacePrComment[] }
  >();
  for (const comment of comments) {
    const group = groups.get(comment.author);
    if (group) {
      group.comments.push(comment);
      group.avatarUrl ??= comment.avatarUrl;
    } else {
      groups.set(comment.author, {
        author: comment.author,
        avatarUrl: comment.avatarUrl,
        comments: [comment],
      });
    }
  }
  return [...groups.values()];
}

export function sortComments(
  comments: WorkspacePrComment[],
  order: "latest" | "oldest",
): WorkspacePrComment[] {
  const stamp = (comment: WorkspacePrComment) => Date.parse(comment.createdAt) || 0;
  return [...comments].sort((a, b) =>
    order === "latest" ? stamp(b) - stamp(a) : stamp(a) - stamp(b),
  );
}

/**
 * A bot's comments as findings, in reading order: still-open before
 * addressed, findings on a file before general notes, most severe first,
 * then by time.
 */
export function orderFindings(
  comments: WorkspacePrComment[],
  order: "latest" | "oldest",
): Array<{ comment: WorkspacePrComment; finding: CommentFinding }> {
  const rank = (finding: CommentFinding) =>
    finding.severity ? SEVERITY_RANK[finding.severity] : 0;
  // `sort` is stable, so the time order survives every tie below.
  return sortComments(comments, order)
    .map((comment) => ({ comment, finding: commentFinding(comment) }))
    .sort(
      (a, b) =>
        Number(a.finding.addressed) - Number(b.finding.addressed) ||
        Number(isInlineComment(b.comment)) - Number(isInlineComment(a.comment)) ||
        rank(b.finding) - rank(a.finding),
    );
}
