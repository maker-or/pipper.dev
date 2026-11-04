"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { PaperclipIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { InputMessage } from "@/components/ui/input-message";
import {
  MentionPopover,
  mentionChipClass,
  type MentionItem,
  type MentionProvider,
} from "@/components/mention-popover";
import { ProjectMark } from "@/components/project-shape";
import { ProviderLogo } from "@/components/provider-logos";
import { cn } from "@/lib/utils";
import { toneIdentity } from "@/lib/workspace-tone";
import { useWorkspaceTone } from "@/lib/workspace-tone-context";
import type {
  ComposerContent,
  ComposerEntityToken,
  ComposerMentionKind,
} from "../../contracts/composer.ts";
import {
  buildContent,
  extractTextContent,
  findActiveMention,
  getEntityTokens,
  getFreeText,
  mentionPlaceholderHint,
  removeEntityKind,
  removeMentionFromText,
  resolveDefaultMentionKind,
  setFreeText,
  upsertEntity,
} from "@/lib/composer-tokens";

export type ThreadComposerMode = "draft" | "live";

export type ThreadComposerProps = {
  mode: ThreadComposerMode;
  content: ComposerContent;
  onContentChange: (content: ComposerContent) => void;
  onSend: (content: ComposerContent, files: File[]) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  isStopping?: boolean;
  isSubmitting?: boolean;
  placeholder?: string;
  files?: File[];
  onFilesChange?: (files: File[]) => void;
  onFilesRejected?: (files: File[], reason: "type" | "limit") => void;
  maxFiles?: number;
  showImageAttach?: boolean;
  /** Project mention items (draft). */
  projects?: MentionItem[];
  /** Agent mention items (draft). */
  agents?: MentionItem[];
  /** Model mention items (draft optional / live switch). */
  models?: MentionItem[];
  /** Provider options for the model picker. Draft can provide all opted-in agents. */
  modelProviders?: MentionProvider[];
  /** Project file paths for `@file` (inserted as text, not chips). */
  projectFiles?: MentionItem[];
  /** Refresh the file catalog when the user opens the file mention picker. */
  onFileMentionOpen?: () => void;
  className?: string;
  /** Decorative identity marker for the next user turn. */
  turnMarker?: React.ReactNode;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  leftSlotExtra?: React.ReactNode;
  /** Additional bottom-right controls before send. */
  rightSlotExtra?: React.ReactNode;
  /** Inherit the conversation background instead of drawing a composer surface. */
  appearance?: "surface" | "plain";
  /** Hide the built-in button when submission is owned by an external composer rail. */
  hideSendButton?: boolean;
  /** Extra key handling after mention keys are processed. */
  onTextareaKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Hide the @project chip when an existing thread or the selected workspace
   * already fixes the project. The project entity
   * stays in content when present — it is just not rendered or deletable.
   */
  hideProjectChip?: boolean;
};

export function ThreadComposer({
  mode,
  content,
  onContentChange,
  onSend,
  disabled = false,
  isStreaming = false,
  onStop,
  isStopping = false,
  isSubmitting = false,
  placeholder,
  files = [],
  onFilesChange,
  onFilesRejected,
  maxFiles,
  showImageAttach = false,
  projects = [],
  agents = [],
  models = [],
  modelProviders: providedModelProviders = [],
  projectFiles = [],
  onFileMentionOpen,
  className,
  turnMarker,
  textareaRef: externalTextareaRef,
  leftSlotExtra,
  rightSlotExtra,
  appearance = "surface",
  hideSendButton = false,
  onTextareaKeyDown,
  hideProjectChip = false,
}: ThreadComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = externalTextareaRef ?? internalRef;
  const mentionFrameRef = useRef<number | null>(null);
  // Caret follows the workspace's git-state tone (light shade of the same
  // hue); falls back to the identity green when no tone is in scope.
  const workspaceTone = useWorkspaceTone();
  const caretColor = workspaceTone ? toneIdentity(workspaceTone).ink : "#26B25A";
  const entities = useMemo(
    () =>
      getEntityTokens(content).filter(
        (entity) => entity.kind !== "agent" && !(hideProjectChip && entity.kind === "project"),
      ),
    [content, hideProjectChip],
  );
  const freeText = useMemo(() => getFreeText(content), [content]);
  const inlineTextRef = useRef<HTMLSpanElement | null>(null);
  const inlineEditorRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const setInlineTextRef = useCallback(
    (node: HTMLSpanElement | null) => {
      inlineTextRef.current = node;
      // ThreadComposer uses a contentEditable span instead of InputMessage's
      // native textarea. Keep the legacy focus ref useful for callers that
      // focus the composer after opening a draft or editing a message.
      if (externalTextareaRef) {
        (externalTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current =
          node as unknown as HTMLTextAreaElement | null;
      }
    },
    [externalTextareaRef],
  );

  const filesAvailable = projectFiles.length > 0 || mode === "live" || mode === "draft";
  const availability = useMemo(
    () => ({
      project: projects.length,
      agent: agents.length,
      model: models.length,
      file: projectFiles.length,
    }),
    [projects.length, agents.length, models.length, projectFiles.length],
  );

  const [mentionKind, setMentionKind] = useState<ComposerMentionKind>(() =>
    resolveDefaultMentionKind({ mode, content, filesAvailable, availability }),
  );
  const [mentionOpen, setMentionOpen] = useState(false);
  useEffect(() => {
    if (mentionOpen && mentionKind === "file") onFileMentionOpen?.();
  }, [mentionOpen, mentionKind, onFileMentionOpen]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedModelProviderId, setSelectedModelProviderId] = useState<string | null>(null);
  const inferredModelProviders = useMemo<MentionProvider[]>(() => {
    const seen = new Set<string>();
    const result: MentionProvider[] = [];
    for (const model of models) {
      const id = model.providerId ?? model.agentId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        label: model.providerLabel ?? model.agentId ?? id,
      });
    }
    return result;
  }, [models]);

  const modelProviders = useMemo<MentionProvider[]>(() => {
    const seen = new Set<string>();
    const result: MentionProvider[] = [];
    for (const provider of [...providedModelProviders, ...inferredModelProviders]) {
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      result.push(provider);
    }
    return result;
  }, [inferredModelProviders, providedModelProviders]);

  // A live thread has one fixed provider, so keep its icon visibly active.
  // Draft mode intentionally starts unfiltered so all opted-in providers are usable.
  const activeModelProviderId =
    selectedModelProviderId ??
    (mode === "live" && modelProviders.length === 1 ? modelProviders[0]?.id : null);

  const itemSource = useMemo(() => {
    if (mentionKind === "project") return projects;
    if (mentionKind === "agent") return agents;
    if (mentionKind === "model") return models;
    return projectFiles;
  }, [mentionKind, projects, agents, models, projectFiles]);

  const filteredItems = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    const providerItems =
      mentionKind === "model" && activeModelProviderId
        ? itemSource.filter((item) => (item.providerId ?? item.agentId) === activeModelProviderId)
        : itemSource;
    if (!q) return providerItems.slice(0, 80);
    return providerItems
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q) ||
          (item.description?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 80);
  }, [activeModelProviderId, itemSource, mentionKind, mentionQuery]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery, mentionKind, filteredItems.length]);

  const closeMention = useCallback(() => {
    if (mentionFrameRef.current !== null) {
      cancelAnimationFrame(mentionFrameRef.current);
      mentionFrameRef.current = null;
    }
    setMentionOpen(false);
    setMentionQuery("");
    setSelectedModelProviderId(null);
  }, []);

  const placeInlineCaret = useCallback((offset: number) => {
    const editor = inlineTextRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    const textNode = editor.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE && textNode.textContent) {
      const safeOffset = Math.max(0, Math.min(offset, textNode.textContent.length));
      range.setStart(textNode, safeOffset);
    } else {
      range.setStart(editor, 0);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const focusInlineEditor = useCallback(() => {
    const editor = inlineTextRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection || !editor.contains(selection.anchorNode)) {
      placeInlineCaret(editor.textContent?.length ?? 0);
    }
  }, [placeInlineCaret]);

  const inlineCursorOffset = useCallback(() => {
    const selection = window.getSelection();
    const editor = inlineTextRef.current;
    if (!selection?.isCollapsed || !editor || !selection.anchorNode) return null;
    if (!editor.contains(selection.anchorNode)) return null;
    return selection.anchorOffset;
  }, []);

  const resolveKindForQuery = useCallback(
    (query: string) =>
      resolveDefaultMentionKind({
        mode,
        content: contentRef.current,
        filesAvailable,
        query,
        availability,
      }),
    [mode, filesAvailable, availability],
  );

  const syncMentionFromText = useCallback(
    (text: string, cursor: number) => {
      const mention = findActiveMention(text, cursor);
      if (!mention) {
        closeMention();
        return;
      }
      const nextKind = resolveKindForQuery(mention.query);
      setMentionKind(nextKind);
      setMentionOpen(true);
      setMentionQuery(mention.query);
    },
    [closeMention, resolveKindForQuery],
  );

  const handleValueChange = useCallback(
    (next: string, nextCursor?: number) => {
      const nextContent = setFreeText(contentRef.current, next);
      contentRef.current = nextContent;
      onContentChange(nextContent);
      const el = textareaRef.current;
      const cursor = nextCursor ?? el?.selectionStart ?? next.length;
      if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
      mentionFrameRef.current = requestAnimationFrame(() => {
        const liveCursor = textareaRef.current?.selectionStart ?? cursor;
        syncMentionFromText(next, liveCursor);
        mentionFrameRef.current = null;
      });
    },
    [onContentChange, syncMentionFromText, textareaRef],
  );

  useEffect(() => {
    return () => {
      if (mentionFrameRef.current !== null) cancelAnimationFrame(mentionFrameRef.current);
    };
  }, []);

  const handleProviderChange = useCallback((providerId: string | null) => {
    setSelectedModelProviderId(providerId);
    setMentionIndex(0);
  }, []);

  const pickItem = useCallback(
    (item: MentionItem) => {
      const currentContent = contentRef.current;
      const currentFreeText = getFreeText(currentContent);
      const el = textareaRef.current;
      const selection = window.getSelection();
      const inlineText = inlineTextRef.current;
      const cursor =
        el?.selectionStart ??
        (selection?.anchorNode && inlineText?.contains(selection.anchorNode)
          ? selection.anchorOffset
          : currentFreeText.length);
      const mention = findActiveMention(currentFreeText, cursor);
      let nextText = currentFreeText;
      if (mention) {
        nextText = removeMentionFromText(currentFreeText, mention);
      }

      // Files insert as plain `@path` text (agent-readable), not control chips.
      if (mentionKind === "file") {
        const insertAt = mention?.atIndex ?? nextText.length;
        const fileLabel = item.label.replace(/^@+/, "");
        const insertion = `@${fileLabel} `;
        nextText = `${nextText.slice(0, insertAt)}${insertion}${nextText.slice(insertAt)}`;
        const nextContent = setFreeText(currentContent, nextText);
        contentRef.current = nextContent;
        onContentChange(nextContent);
        closeMention();
        requestAnimationFrame(() => {
          const caret = insertAt + insertion.length;
          placeInlineCaret(caret);
        });
        return;
      }

      let entity: ComposerEntityToken;
      if (mentionKind === "project") {
        entity = { kind: "project", id: item.id, label: item.label, icon: item.icon };
      } else if (mentionKind === "agent") {
        entity = { kind: "agent", id: item.id, label: item.label };
      } else {
        entity = {
          kind: "model",
          id: item.id,
          label: item.label,
          agentId: item.agentId,
          providerId: item.providerId,
        };
      }
      const withEntity = upsertEntity(setFreeText(currentContent, nextText), entity);
      contentRef.current = withEntity;
      onContentChange(withEntity);
      closeMention();
      requestAnimationFrame(() => {
        const caret = Math.min(mention?.atIndex ?? nextText.length, nextText.length);
        placeInlineCaret(caret);
      });
    },
    [closeMention, mentionKind, onContentChange, placeInlineCaret, textareaRef],
  );

  const handleSend = useCallback(
    (_value: string, sendFiles: File[]) => {
      if (disabled || isSubmitting) return;
      closeMention();
      onSend(contentRef.current, sendFiles);
    },
    [closeMention, disabled, isSubmitting, onSend],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (mentionOpen && filteredItems.length > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setMentionIndex(
            (current) => (current + delta + filteredItems.length) % filteredItems.length,
          );
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const item = filteredItems[mentionIndex] ?? filteredItems[0];
          if (item) pickItem(item);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeMention();
          return;
        }
      }
      onTextareaKeyDown?.(event as ReactKeyboardEvent<HTMLTextAreaElement>);
    },
    [closeMention, filteredItems, mentionIndex, mentionOpen, onTextareaKeyDown, pickItem],
  );

  const resolvedPlaceholder = placeholder ?? mentionPlaceholderHint(mode, content, availability);

  const textForSend = extractTextContent(content);
  const canSend = textForSend.length > 0 || files.length > 0;

  // When content chips change while popover is closed, keep kind aligned for next @.
  useEffect(() => {
    if (mentionOpen) return;
    setMentionKind(resolveDefaultMentionKind({ mode, content, filesAvailable, availability }));
  }, [mode, content, filesAvailable, availability, mentionOpen]);

  // The editable text node is intentionally uncontrolled while the user types.
  // Sync only external changes so React never reconciles children inside a
  // contentEditable element.
  useEffect(() => {
    const editor = inlineTextRef.current;
    if (editor && editor.textContent !== freeText) editor.textContent = freeText;
  }, [freeText]);

  // Keep chips and the editable text in one inline formatting context.
  // A flex row makes the text span its own permanent column, so wrapped
  // lines stay indented after the last chip instead of using the full
  // composer width.
  const inlineEditor = (
    <div
      ref={inlineEditorRef}
      className="block min-h-11 min-w-0 flex-1 cursor-text overflow-x-hidden px-2 py-2 text-[14px] leading-5 text-foreground outline-none"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={mode === "draft" ? "New thread composer" : "Message composer"}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button") || target.closest('[contenteditable="true"]')) return;
        event.preventDefault();
        focusInlineEditor();
      }}
      onInput={(event) => {
        const text =
          event.currentTarget.querySelector<HTMLElement>("[data-inline-text]")?.textContent ?? "";
        const selection = window.getSelection();
        const textNode = event.currentTarget.querySelector<HTMLElement>("[data-inline-text]");
        const cursor =
          selection && textNode && selection.anchorNode && textNode.contains(selection.anchorNode)
            ? selection.anchorOffset
            : text.length;
        handleValueChange(text, cursor);
      }}
      onKeyDown={(event) => {
        const cursor = inlineCursorOffset();
        const visibleEntities = entities.filter((entity) => entity.kind !== "agent");
        if (cursor === 0 && visibleEntities.length > 0 && event.key === "Backspace") {
          event.preventDefault();
          const previous = visibleEntities[visibleEntities.length - 1]!;
          const nextContent = removeEntityKind(contentRef.current, previous.kind);
          contentRef.current = nextContent;
          onContentChange(nextContent);
          requestAnimationFrame(() => placeInlineCaret(0));
          return;
        }
        if (cursor === 0 && visibleEntities.length > 0 && event.key === "Delete") {
          event.preventDefault();
          const nextContent = removeEntityKind(contentRef.current, visibleEntities[0]!.kind);
          contentRef.current = nextContent;
          onContentChange(nextContent);
          requestAnimationFrame(() => placeInlineCaret(0));
          return;
        }
        onKeyDown(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          handleSend(getFreeText(content), files);
        }
      }}
    >
      {entities
        .filter((entity) => entity.kind !== "agent")
        .map((entity) => {
          let iconNode: React.ReactNode = null;
          if (entity.kind === "project") {
            const projectItem = projects.find((p) => p.id === entity.id);
            const icon = entity.icon ?? projectItem?.icon ?? null;
            iconNode = (
              <ProjectMark project={{ id: entity.id, icon }} className="size-3.5 shrink-0" />
            );
          } else if (entity.kind === "model") {
            const modelItem = models.find((m) => m.id === entity.id);
            const providerKey =
              entity.providerId ??
              modelItem?.providerId ??
              entity.agentId ??
              modelItem?.agentId ??
              entity.id;
            iconNode = (
              <ProviderLogo provider={providerKey} size={13} className="size-3.5 shrink-0" />
            );
          }

          return (
            <span
              key={`${entity.kind}:${entity.id}`}
              contentEditable={false}
              title={`${entity.label}`}
              className={cn(
                "mr-1.5 inline-flex h-7 min-w-0 max-w-[min(100%,22rem)] shrink items-center gap-1.5 rounded-full px-2.5 align-middle text-[14px] leading-none font-semibold",
                mentionChipClass(entity.kind),
              )}
            >
              {iconNode}
              <span className="min-w-0 truncate leading-none">{entity.label}</span>
            </span>
          );
        })}
      <span
        ref={setInlineTextRef}
        data-inline-text
        contentEditable={!disabled}
        tabIndex={0}
        className="inline-block min-w-[2px] cursor-text whitespace-pre-wrap break-words [overflow-wrap:anywhere] outline-none align-middle empty:before:inline-block empty:before:align-middle empty:before:max-w-full empty:before:overflow-hidden empty:before:text-ellipsis empty:before:whitespace-nowrap empty:before:text-muted-foreground empty:before:pointer-events-none empty:before:content-[attr(data-placeholder)]"
        style={{ caretColor }}
        data-placeholder={resolvedPlaceholder}
      />
    </div>
  );

  return (
    <div className={cn("flex items-center gap-3", className)} data-pipper-id="thread-composer">
      {turnMarker ? (
        // self-start + pt-1.5 keeps the marker on the composer's first text
        // line as the input grows, instead of centring on the whole box.
        <div
          className="flex shrink-0 items-center self-start pt-1.5"
          data-pipper-id="composer-turn-marker"
        >
          {turnMarker}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <InputMessage
          className="relative z-10"
          textareaRef={textareaRef}
          value={freeText}
          onValueChange={handleValueChange}
          placeholder={resolvedPlaceholder}
          onSend={handleSend}
          customInput={inlineEditor}
          compact
          appearance={appearance}
          disabled={disabled}
          canSendWhenEmpty={files.length > 0}
          files={onFilesChange ? files : undefined}
          onFilesChange={onFilesChange}
          onFilesRejected={onFilesRejected}
          accept="image/png,image/jpeg,image/gif,image/webp"
          maxFiles={maxFiles}
          isStreaming={isStreaming}
          onStop={onStop}
          isStopping={isStopping}
          sendLabel={isSubmitting ? "Sending" : "Send"}
          hideSendButton={hideSendButton}
          disableFileMentions
          leftSlot={
            showImageAttach && onFilesChange
              ? ({ openFilePicker }) => (
                  <>
                    {leftSlotExtra}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-pipper-id="attach-image-button"
                      aria-label="Attach images"
                      onClick={() => openFilePicker("image/png,image/jpeg,image/gif,image/webp")}
                    >
                      <PaperclipIcon size={17} />
                    </Button>
                  </>
                )
              : leftSlotExtra
                ? () => <>{leftSlotExtra}</>
                : undefined
          }
          rightSlot={rightSlotExtra ? () => <>{rightSlotExtra}</> : undefined}
          textareaProps={{
            onKeyDown,
            "aria-label": mode === "draft" ? "New thread composer" : "Message composer",
          }}
        />

        {mentionOpen ? (
          <MentionPopover
            anchorRef={inlineEditorRef}
            kind={mentionKind}
            items={filteredItems}
            selectedIndex={mentionIndex}
            onSelectedIndexChange={setMentionIndex}
            onPick={pickItem}
            onClose={closeMention}
            providers={modelProviders}
            selectedProviderId={activeModelProviderId}
            onProviderChange={handleProviderChange}
          />
        ) : null}

        <span className="sr-only" aria-hidden>
          {canSend ? "ready" : "empty"}
        </span>
      </div>
    </div>
  );
}

/** Build initial draft content with optional soft-default project chip. */
export function initialDraftContent(
  project?: { id: string; name: string; icon?: string | null } | null,
): ComposerContent {
  if (!project) return buildContent([], "");
  return buildContent(
    [{ kind: "project", id: project.id, label: project.name, icon: project.icon }],
    "",
  );
}
