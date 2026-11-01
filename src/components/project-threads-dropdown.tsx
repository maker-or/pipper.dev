"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowElbowDownRightIcon,
  ChatCircleIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project-store";
import { useAgentStore } from "@/store/agent-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { confirmDiscardDraft, selectThread } from "@/lib/thread-actions";
import { useQueryClient } from "@tanstack/react-query";
import { OPEN_TABS_QUERY_KEY } from "@/lib/thread-queries";
import { Dropdown, DropdownLabel, DropdownSeparator } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import type { Thread } from "../../contracts/threads.ts";
import { nestThreads, taskStatusText } from "@/lib/agent-task-tree";

const PAGE_SIZE = 5;

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The project's thread history. `project` overrides the active project (the
 * hybrid shell passes a draft's project while drafting).
 */
export function ProjectThreadsDropdown({ project }: { project?: Project | null } = {}) {
  const storeProject = useProjectStore((s) => s.activeProject);
  const activeProject = project === undefined ? storeProject : project;
  const activeThreadId = useAgentStore((s) => s.snapshot?.threadId);
  const agentTasks = useAgentStore((s) => s.agentTasks);
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchInitialThreads = useCallback(async () => {
    if (!activeProject?.id) return;
    setIsLoading(true);
    try {
      const page = await window.omni.threads.listProject({
        projectId: activeProject.id,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setThreads(page.threads);
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
    } catch (err) {
      console.error("Failed to fetch project threads:", err);
    } finally {
      setIsLoading(false);
    }
  }, [activeProject?.id]);

  const handleLoadMore = async () => {
    if (!activeProject?.id || isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const page = await window.omni.threads.listProject({
        projectId: activeProject.id,
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      setThreads((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const newThreads = page.threads.filter((t) => !existingIds.has(t.id));
        return [...prev, ...newThreads];
      });
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
    } catch (err) {
      console.error("Failed to load more project threads:", err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const toggleDropdown = () => {
    if (!isOpen) {
      void fetchInitialThreads();
    }
    setIsOpen((prev) => !prev);
  };

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target) &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleSelectThread = async (threadId: string) => {
    try {
      const viewState = useWorkspaceViewStore.getState();
      if (viewState.draft?.dirty) {
        const ok = confirmDiscardDraft();
        if (!ok) return;
      }
      if (viewState.draft) {
        viewState.endDraft();
      }
      await window.omni.tabs.open(threadId);
      await queryClient.invalidateQueries({ queryKey: OPEN_TABS_QUERY_KEY });
      await selectThread(threadId, { activateView: true });
    } catch (err) {
      console.error("Failed to select thread:", err);
    } finally {
      setIsOpen(false);
    }
  };

  const rows = useMemo(() => nestThreads(threads, agentTasks), [threads, agentTasks]);

  if (!activeProject) return null;

  const checkedIndex = rows.findIndex((row) => row.thread.id === activeThreadId);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleDropdown}
        aria-label="Project threads"
        title="Project threads"
        className={cn(
          "relative inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isOpen
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        data-pipper-id="header-project-threads-toggle"
      >
        <ClockCounterClockwiseIcon weight="duotone" className="size-4" />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute right-0 top-full mt-1.5 z-[200]"
          data-pipper-id="project-threads-dropdown-menu"
        >
          <Dropdown
            checkedIndex={checkedIndex >= 0 ? checkedIndex : undefined}
            className="w-72 max-h-[340px]"
          >
            <DropdownLabel className="font-semibold text-xs border-b border-border/50 pb-1.5 mb-0.5">
              {activeProject.name}
            </DropdownLabel>

            {isLoading ? (
              <DropdownLabel className="flex items-center justify-center py-5 text-xs text-muted-foreground">
                <CircleNotchIcon className="size-4 animate-spin mr-2" />
                <span>Loading threads...</span>
              </DropdownLabel>
            ) : threads.length === 0 ? (
              <DropdownLabel className="py-5 text-center text-xs text-muted-foreground">
                No threads found for this project.
              </DropdownLabel>
            ) : (
              <>
                {rows.map(({ thread, depth, task }, idx) => {
                  const when = formatTimestamp(thread.last_used_at || thread.created_at);
                  return (
                    <MenuItem
                      key={thread.id}
                      index={idx}
                      label={thread.title?.trim() || "Untitled thread"}
                      description={task ? `${taskStatusText(task)} · ${when}` : when}
                      icon={depth > 0 ? ArrowElbowDownRightIcon : ChatCircleIcon}
                      checked={thread.id === activeThreadId}
                      onSelect={() => void handleSelectThread(thread.id)}
                      style={depth > 0 ? { paddingLeft: `${depth * 12}px` } : undefined}
                    />
                  );
                })}

                {hasMore && (
                  <>
                    <DropdownSeparator />
                    <MenuItem
                      index={threads.length}
                      label={isLoadingMore ? "Loading..." : "Load More"}
                      onSelect={() => void handleLoadMore()}
                    />
                  </>
                )}
              </>
            )}
          </Dropdown>
        </div>
      )}
    </div>
  );
}
