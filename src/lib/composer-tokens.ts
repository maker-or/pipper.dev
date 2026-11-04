import type {
  ComposerAgentToken,
  ComposerContent,
  ComposerEntityToken,
  ComposerMentionKind,
  ComposerModelToken,
  ComposerProjectToken,
  ComposerToken,
  ComposerTextToken,
} from "../../contracts/composer.ts";

export type {
  ComposerAgentToken,
  ComposerContent,
  ComposerEntityToken,
  ComposerMentionKind,
  ComposerModelToken,
  ComposerProjectToken,
  ComposerToken,
  ComposerTextToken,
} from "../../contracts/composer.ts";

/** Active @-mention being typed inside a text token. */
export type ActiveMention = {
  /** Index of the text token containing the mention. */
  tokenIndex: number;
  /** Absolute start of `@` within that token's text. */
  atIndex: number;
  /** Query after `@` (no spaces). */
  query: string;
  /** Full match including `@`. */
  raw: string;
};

export function blankContent(): ComposerContent {
  return [{ kind: "text", text: "" }];
}

export function isEntityToken(token: ComposerToken): token is ComposerEntityToken {
  return token.kind === "project" || token.kind === "agent" || token.kind === "model";
}

export function isTextToken(token: ComposerToken): token is ComposerTextToken {
  return token.kind === "text";
}

/** Merge adjacent text tokens and drop empty text tokens between entities. */
export function normalizeContent(content: ComposerContent): ComposerContent {
  const out: ComposerToken[] = [];
  for (const token of content) {
    if (token.kind === "text") {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "text") {
        prev.text += token.text;
        continue;
      }
      out.push({ kind: "text", text: token.text });
      continue;
    }
    out.push(token);
  }
  // Ensure there is always a trailing text token so the caret has a place.
  if (out.length === 0 || out[out.length - 1]!.kind !== "text") {
    out.push({ kind: "text", text: "" });
  }
  return out;
}

/** Plain text the agent should receive (entity chips stripped). */
export function extractTextContent(content: ComposerContent): string {
  return content
    .filter(isTextToken)
    .map((t) => t.text)
    .join("")
    .trim();
}

/**
 * Human-readable serialization: entity tokens become their labels, text as-is.
 * Useful for titles / display — not for agent prompts (use extractTextContent).
 */
export function serialize(content: ComposerContent): string {
  return content
    .map((token) => {
      if (token.kind === "text") return token.text;
      return token.label;
    })
    .join("")
    .trim();
}

/** Last project token wins. */
export function extractProjectId(content: ComposerContent): string | null {
  let id: string | null = null;
  for (const token of content) {
    if (token.kind === "project") id = token.id;
  }
  return id;
}

/** Last agent token wins. */
export function extractAgentId(content: ComposerContent): string | null {
  let id: string | null = null;
  for (const token of content) {
    if (token.kind === "agent") id = token.id;
  }
  return id;
}

/** Last model token wins. */
export function extractModelId(content: ComposerContent): string | null {
  let id: string | null = null;
  for (const token of content) {
    if (token.kind === "model") id = token.id;
  }
  return id;
}

export function extractModelToken(content: ComposerContent): ComposerModelToken | null {
  let found: ComposerModelToken | null = null;
  for (const token of content) {
    if (token.kind === "model") found = token;
  }
  return found;
}

/**
 * Agent for thread creation: explicit @agent chip, else owning agent on the
 * model chip (model-first draft UX), else an optional soft default.
 */
export function resolveAgentId(
  content: ComposerContent,
  fallbackAgentId?: string | null,
): string | null {
  return extractAgentId(content) ?? extractModelToken(content)?.agentId ?? fallbackAgentId ?? null;
}

/** Strip entity tokens of the given kinds; keep text. */
export function stripEntityKinds(
  content: ComposerContent,
  kinds: ReadonlyArray<ComposerEntityToken["kind"]>,
): ComposerContent {
  const kindSet = new Set(kinds);
  return normalizeContent(content.filter((t) => t.kind === "text" || !kindSet.has(t.kind)));
}

/** Remove all entity tokens; keep text only. */
export function stripAllEntities(content: ComposerContent): ComposerContent {
  return normalizeContent(content.filter(isTextToken));
}

/**
 * Detect an in-progress @mention at `cursor` within a single text buffer.
 * Mentions end at whitespace or end of string; do not cross newlines.
 */
export function findActiveMentionInText(
  text: string,
  cursor: number,
): Omit<ActiveMention, "tokenIndex"> | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  // Walk backward from cursor for the start of the current word.
  let i = safeCursor - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "\n" || ch === "\r" || /\s/.test(ch)) break;
    i -= 1;
  }
  const wordStart = i + 1;
  const word = text.slice(wordStart, safeCursor);
  if (!word.startsWith("@")) return null;
  // Bare `@` or `@query` — query cannot contain another `@`.
  const body = word.slice(1);
  if (body.includes("@")) return null;
  return {
    atIndex: wordStart,
    query: body,
    raw: word,
  };
}

/**
 * Find active mention across tokenized content. Cursor is an absolute offset
 * into the concatenated text-only buffer (entity tokens contribute 0 length
 * for caret math when editing only the free-text field).
 *
 * For the chip + single-textarea model we use a simpler path: active mention
 * is always searched in the concatenated free-text string.
 */
export function findActiveMention(
  freeText: string,
  cursor: number,
): Omit<ActiveMention, "tokenIndex"> | null {
  return findActiveMentionInText(freeText, cursor);
}

export function contentFromFreeText(
  text: string,
  entities: ComposerEntityToken[] = [],
): ComposerContent {
  return normalizeContent([...entities, { kind: "text", text }]);
}

/**
 * Split free text into content: entities stay as provided (leading chips),
 * free text is the single trailing text token.
 */
export function buildContent(entities: ComposerEntityToken[], freeText: string): ComposerContent {
  return normalizeContent([...entities, { kind: "text", text: freeText }]);
}

export function getEntityTokens(content: ComposerContent): ComposerEntityToken[] {
  return content.filter(isEntityToken);
}

export function getFreeText(content: ComposerContent): string {
  return content
    .filter(isTextToken)
    .map((t) => t.text)
    .join("");
}

/** Replace the active @mention in free text with nothing (chip is added separately). */
export function removeMentionFromText(
  text: string,
  mention: Omit<ActiveMention, "tokenIndex">,
): string {
  return text.slice(0, mention.atIndex) + text.slice(mention.atIndex + mention.raw.length);
}

/**
 * Upsert an entity token of a given kind (last-one-wins semantics: remove
 * existing tokens of the same kind, append the new one).
 */
export function upsertEntity(
  content: ComposerContent,
  entity: ComposerEntityToken,
): ComposerContent {
  const without = content.filter((t) => t.kind !== entity.kind);
  const freeText = getFreeText(without);
  const others = getEntityTokens(without);
  return buildContent([...others, entity], freeText);
}

export function removeEntityKind(
  content: ComposerContent,
  kind: ComposerEntityToken["kind"],
): ComposerContent {
  const freeText = getFreeText(content);
  const others = getEntityTokens(content).filter((t) => t.kind !== kind);
  return buildContent(others, freeText);
}

export function setFreeText(content: ComposerContent, freeText: string): ComposerContent {
  return buildContent(getEntityTokens(content), freeText);
}

export type CreatableCheck =
  | { ok: true; projectId: string; agentId: string; modelId: string | null; text: string }
  | { ok: false; reason: "missing_project" | "missing_agent" | "empty_text" };

/** Validate draft content for thread creation. */
export function assertCreatable(
  content: ComposerContent,
  options: { defaultAgentId?: string | null; defaultProjectId?: string | null } = {},
): CreatableCheck {
  const projectId = extractProjectId(content) ?? options.defaultProjectId ?? null;
  const agentId = resolveAgentId(content, options.defaultAgentId);
  const modelId = extractModelId(content);
  const text = extractTextContent(content);
  if (!projectId) return { ok: false, reason: "missing_project" };
  if (!agentId) return { ok: false, reason: "missing_agent" };
  if (!text) return { ok: false, reason: "empty_text" };
  return { ok: true, projectId, agentId, modelId, text };
}

/**
 * Slot-based mention intelligence.
 *
 * Draft (new thread): fill control slots in order, then files forever.
 *   project → model → file
 *
 * The agent is not a user-facing mention step — it is inferred from the
 * selected model (or a soft default when only one agent is available).
 *
 * Live (existing thread): project is fixed by the thread; agent is fixed.
 *   model (optional switch) → file (primary ongoing action)
 *
 * "First `@`" / "second `@`" falls out of unfilled slots:
 * - New thread with soft project chip: first `@` opens model (project filled)
 * - New thread with no project: first `@` opens project, second opens model
 * - Live: first `@` opens model if no model chip this turn, else file;
 *   after a model chip is present, `@` defaults to file
 * - Path-like queries always bias to file
 */

/** How many items each kind can offer right now (0 = skip as smart default). */
export type MentionAvailability = Partial<Record<ComposerMentionKind, number>>;

export type MentionContext = {
  mode: "draft" | "live";
  content: ComposerContent;
  /** When false, file mentions are not offered (no project cwd yet). */
  filesAvailable?: boolean;
  /**
   * Optional override when the popover is already open on a kind (tabs).
   * Does not change priority computation — only defaultMentionKind honors it
   * if still allowed.
   */
  preferredKind?: ComposerMentionKind | null;
  /** Active @query (without @) — used for path heuristics. */
  query?: string;
  /**
   * Live item counts per kind. Kinds with count 0 are skipped as the smart
   * default so we never open an empty Agents/Models list (e.g. draft has no
   * session models yet). Tabs can still select an empty kind intentionally.
   */
  availability?: MentionAvailability;
};

/** Priority order of kinds for a mode (not yet filtered by filled slots). */
export function mentionPriority(mode: "draft" | "live"): ComposerMentionKind[] {
  // Draft: project then model. Agent is inferred from the model (or soft default).
  if (mode === "draft") return ["project", "model", "file"];
  // Live: file first, then models.
  return ["file", "model"];
}

/** Whether a control slot is already satisfied (file is never "filled"). */
export function isMentionSlotFilled(
  kind: ComposerMentionKind,
  content: ComposerContent,
  mode: "draft" | "live",
): boolean {
  if (kind === "file") return false;
  if (kind === "project") {
    // Live threads already own a project — treat as filled so we never offer it.
    if (mode === "live") return true;
    return extractProjectId(content) != null;
  }
  if (kind === "agent") {
    // Agent is never a draft mention slot (model-first). Treat as filled so
    // legacy chips do not re-open an Agents tab.
    return true;
  }
  if (kind === "model") {
    return extractModelId(content) != null;
  }
  return false;
}

/** Kinds still allowed in the popover (tabs), including already-filled for re-pick. */
export function allowedMentionKinds(
  mode: "draft" | "live",
  options: { filesAvailable?: boolean } = {},
): ComposerMentionKind[] {
  const filesAvailable = options.filesAvailable !== false;
  return mentionPriority(mode).filter((kind) => {
    if (kind === "file") return filesAvailable;
    if (kind === "agent") return false;
    if (mode === "live" && kind === "project") return false;
    return true;
  });
}

/** Unfilled slots in priority order — the "smart next" sequence. */
export function unfilledMentionKinds(ctx: MentionContext): ComposerMentionKind[] {
  const filesAvailable = ctx.filesAvailable !== false;
  return mentionPriority(ctx.mode).filter((kind) => {
    if (kind === "file") return filesAvailable;
    if (kind === "agent") return false;
    if (ctx.mode === "live" && kind === "project") return false;
    return !isMentionSlotFilled(kind, ctx.content, ctx.mode);
  });
}

/** Path-like query → bias to files (e.g. `@src/`, `@foo.ts`). */
export function queryLooksLikeFilePath(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (q.includes("/") || q.includes("\\")) return true;
  if (/\.[a-zA-Z0-9]{1,8}$/.test(q)) return true;
  return false;
}

function kindHasItems(kind: ComposerMentionKind, availability?: MentionAvailability): boolean {
  if (!availability) return true;
  const count = availability[kind];
  // Undefined = unknown catalog → still offer; 0 = known empty → skip.
  if (count === undefined) return true;
  return count > 0;
}

/**
 * Which list to open when the user types `@`.
 * 1. Preferred kind if still allowed (tab sticky)
 * 2. Path-like query → file when available
 * 3. First unfilled slot in priority order that has items
 * 4. Fallback: file (if available) else first allowed kind with items
 */
export function resolveDefaultMentionKind(ctx: MentionContext): ComposerMentionKind {
  const allowed = allowedMentionKinds(ctx.mode, { filesAvailable: ctx.filesAvailable });
  if (allowed.length === 0) return "file";

  if (ctx.preferredKind && allowed.includes(ctx.preferredKind)) {
    return ctx.preferredKind;
  }

  const query = ctx.query ?? "";
  if (
    queryLooksLikeFilePath(query) &&
    allowed.includes("file") &&
    kindHasItems("file", ctx.availability)
  ) {
    return "file";
  }

  const unfilled = unfilledMentionKinds(ctx).filter(
    (kind) => allowed.includes(kind) && kindHasItems(kind, ctx.availability),
  );
  if (unfilled[0]) return unfilled[0];

  // All control slots filled or empty catalogs — prefer files, else any kind with items.
  const withItems = allowed.filter((kind) => kindHasItems(kind, ctx.availability));
  // Files are a persistent final slot. If the project file catalog is known
  // to be empty (often while it is still loading after project selection), do
  // not fall back to the first control tab and make the user re-enter the
  // mention. Keep the popover on Files so it can update when the catalog lands.
  if (allowed.includes("file") && ctx.availability?.file === 0) return "file";
  if (withItems.includes("file")) return "file";
  if (withItems[0]) return withItems[0];
  return allowed[0]!;
}

/** @deprecated Prefer resolveDefaultMentionKind with full context. */
export function defaultMentionKind(
  mode: "draft" | "live",
  preferred?: ComposerMentionKind | null,
): ComposerMentionKind {
  return resolveDefaultMentionKind({
    mode,
    content: blankContent(),
    preferredKind: preferred,
  });
}

/** Human hint for the composer placeholder. */
export function mentionPlaceholderHint(
  mode: "draft" | "live",
  content: ComposerContent,
  availability?: MentionAvailability,
): string {
  const next = resolveDefaultMentionKind({ mode, content, filesAvailable: true, availability });
  if (mode === "draft") {
    if (next === "project") return "@ a project, then a model, then describe the task…";
    if (next === "model") return "@ a model, then describe the task…";
    return "Describe the task — @ for files";
  }
  if (next === "model") return "Type here — @model to switch, or @ for files";
  return "Type here — @ to mention a file";
}

export function titleFromText(text: string, max = 48): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New thread";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}
