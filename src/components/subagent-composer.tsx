"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Graph, Plus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/icon-context";
import { Elevated } from "@/lib/elevated";
import { useShape } from "@/lib/shape-context";
import { fontWeights } from "@/lib/font-weight";
import { springs } from "@/lib/springs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabItem } from "@/components/ui/tabs";
import { createProviderLogoIcon } from "@/components/provider-logos";
import type { IconComponent } from "@/lib/icon-context";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskConfig } from "../../contracts/agent-tasks.ts";
import {
  composeOrchestrationPrompt,
  emptyOrchestrationDraft,
  newAssignment,
  validateOrchestrationDraft,
  type OrchestrationDraft,
} from "@/lib/subagent-orchestration";

export interface SubagentComposerSubmit {
  prompt: string;
  orchestratorAgentId: string;
  draft: OrchestrationDraft;
}

interface SubagentComposerProps {
  /** Installed agents (unavailable ones are filtered out here). */
  agents: AcpAgentDescriptor[];
  /** Preselected orchestrator — usually the active thread's agent. */
  defaultOrchestratorId: string | null;
  /** Seeds the goal, e.g. the remainder of "/subagent fix the login flow". */
  initialGoal?: string;
  onSubmit: (payload: SubagentComposerSubmit) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
  className?: string;
}

const PARALLEL_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Icon-only agent strip — same Tabs chrome as Auto / Manual. */
function AgentTabs({
  agents,
  selectedId,
  onSelect,
  "aria-label": ariaLabel,
}: {
  agents: AcpAgentDescriptor[];
  selectedId: string;
  onSelect: (agentId: string) => void;
  "aria-label"?: string;
}) {
  const icons = useMemo(() => {
    const next: Record<string, IconComponent> = {};
    for (const agent of agents) {
      next[agent.id] = createProviderLogoIcon(agent.id, agent.displayName);
    }
    return next;
  }, [agents]);

  if (agents.length === 0) return null;

  return (
    <Tabs value={selectedId} onValueChange={onSelect}>
      <TabsList aria-label={ariaLabel}>
        {agents.map((agent) => (
          <TabItem
            key={agent.id}
            value={agent.id}
            label={agent.displayName}
            icon={icons[agent.id]}
            iconOnly
          />
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Numbered strip for how many subagents may run at once. */
function ParallelTabs({ value, onChange }: { value: number; onChange: (count: number) => void }) {
  return (
    <Tabs
      value={String(value)}
      onValueChange={(next) => {
        const count = Number(next);
        if (!Number.isInteger(count) || count < 1 || count > 8) return;
        onChange(count);
      }}
    >
      <TabsList aria-label="Max parallel subagents">
        {PARALLEL_COUNTS.map((count) => (
          <TabItem
            key={count}
            value={String(count)}
            label={String(count)}
            className="px-2.5 py-1"
          />
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * The composer, morphed into orchestration mode by `/subagent`: pick an
 * orchestrator, describe a goal (auto) or assign per-agent tasks (manual),
 * and submit one orchestration prompt to the orchestrator's thread. The
 * orchestrator starts each subagent as a task thread through the
 * client-hosted `pipper-agents` tools (docs/agent-tasks/design.md).
 */
export function SubagentComposer({
  agents,
  defaultOrchestratorId,
  initialGoal,
  onSubmit,
  onCancel,
  isSubmitting = false,
  className,
}: SubagentComposerProps) {
  const shape = useShape();
  const prefersReducedMotion = useReducedMotion();
  const installed = useMemo(() => agents.filter((a) => a.available !== false), [agents]);
  const [orchestratorId, setOrchestratorId] = useState(
    () => installed.find((a) => a.id === defaultOrchestratorId)?.id ?? installed[0]?.id ?? "",
  );
  const [draft, setDraft] = useState<OrchestrationDraft>(() => ({
    ...emptyOrchestrationDraft(),
    goal: initialGoal?.trim() ?? "",
  }));
  const [config, setConfig] = useState<AgentTaskConfig | null>(null);

  useEffect(() => {
    let stale = false;
    void window.omni?.agentTasks
      ?.getConfig()
      .then((loaded) => {
        if (!stale) setConfig(loaded);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  // Agents the user allows as tasks (agent-tasks.json); orchestrator can be anyone.
  const subagentChoices = useMemo(() => {
    if (!config || config.allowedAgents === "all") return installed;
    const allowed = new Set(config.allowedAgents);
    return installed.filter((a) => allowed.has(a.id));
  }, [config, installed]);

  const validationError = validateOrchestrationDraft(draft);
  const canSubmit = !validationError && Boolean(orchestratorId) && !isSubmitting;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      prompt: composeOrchestrationPrompt(draft, installed, config?.maxRunningPerThread),
      orchestratorAgentId: orchestratorId,
      draft,
    });
  };

  const updateConfig = (partial: Partial<AgentTaskConfig>) => {
    if (!config) return;
    const previous = config;
    const next = { ...config, ...partial };
    setConfig(next);
    void window.omni?.agentTasks
      ?.setConfig(partial)
      .then((saved) => setConfig(saved))
      .catch(() => setConfig(previous));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  const setAssignment = (id: string, patch: Partial<{ agentId: string; task: string }>) => {
    setDraft((current) => ({
      ...current,
      assignments: current.assignments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  };

  const setMode = (mode: string) => {
    if (mode !== "auto" && mode !== "manual") return;
    setDraft((current) => ({ ...current, mode }));
  };

  const textareaClasses =
    "w-full resize-none bg-transparent outline-none text-[13px] leading-5 text-foreground placeholder:text-muted-foreground";

  return (
    <Elevated
      offset={1}
      shadowLevel={2}
      data-pipper-id="subagent-composer"
      onKeyDown={handleKeyDown}
      className={cn("flex flex-col gap-2.5 p-2.5", shape.container, className)}
    >
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5">
          <Graph size={14} className="text-muted-foreground" />
          <span
            className="text-[12px] text-foreground"
            style={{ fontVariationSettings: fontWeights.medium }}
          >
            Orchestrate subagents
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close orchestration"
          onClick={onCancel}
        >
          <Icon name="x" className="size-3.5" strokeWidth={2} />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 px-0.5">
        <span className="text-[11px] text-muted-foreground">Orchestrator</span>
        <AgentTabs
          agents={installed}
          selectedId={orchestratorId}
          onSelect={setOrchestratorId}
          aria-label="Orchestrator"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-0.5">
        <Tabs value={draft.mode} onValueChange={setMode}>
          <TabsList>
            <TabItem value="auto" label="Auto" className="px-2.5 py-1" />
            <TabItem value="manual" label="Manual" className="px-2.5 py-1" />
          </TabsList>
        </Tabs>
        <span className="min-w-0 text-[11px] leading-4 text-muted-foreground">
          {draft.mode === "auto"
            ? "The orchestrator splits the goal across this many subagents."
            : "Assign each subagent its own task."}
        </span>
      </div>

      {config && (
        <div className="flex flex-wrap items-center gap-2 px-0.5">
          <span className="text-[11px] text-muted-foreground">Parallel</span>
          <ParallelTabs
            value={config.maxRunningPerThread}
            onChange={(maxRunningPerThread) => updateConfig({ maxRunningPerThread })}
          />
          <span className="min-w-0 text-[11px] leading-4 text-muted-foreground">
            {draft.mode === "auto"
              ? "How many subagents auto mode may spawn."
              : "How many assigned subagents may run at once."}
          </span>
        </div>
      )}

      <AnimatePresence initial={false}>
        {draft.mode === "manual" && (
          <motion.div
            key="manual-assignments"
            initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={
              prefersReducedMotion
                ? { opacity: 0 }
                : { height: 0, opacity: 0, transition: springs.fast }
            }
            transition={prefersReducedMotion ? { duration: 0 } : springs.moderate}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1.5">
              {draft.assignments.map((assignment, index) => (
                <Elevated
                  key={assignment.id}
                  offset={1}
                  data-pipper-id="subagent-assignment"
                  className={cn("flex flex-col gap-1.5 p-2", shape.item)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <AgentTabs
                        agents={subagentChoices}
                        selectedId={assignment.agentId}
                        onSelect={(agentId) => setAssignment(assignment.id, { agentId })}
                        aria-label={`Subagent ${index + 1} agent`}
                      />
                    </div>
                    {draft.assignments.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove subagent ${index + 1}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            assignments: current.assignments.filter((a) => a.id !== assignment.id),
                          }))
                        }
                      >
                        <Icon name="x" className="size-3" strokeWidth={2} />
                      </Button>
                    )}
                  </div>
                  <textarea
                    value={assignment.task}
                    onChange={(event) => setAssignment(assignment.id, { task: event.target.value })}
                    placeholder={`Task for subagent ${index + 1}…`}
                    rows={2}
                    aria-label={`Subagent ${index + 1} task`}
                    className={cn(textareaClasses, "px-1")}
                  />
                </Elevated>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    assignments: [...current.assignments, newAssignment()],
                  }))
                }
              >
                <Plus size={13} />
                Add subagent
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="h-px bg-border/60" />

      <textarea
        autoFocus
        value={draft.goal}
        onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && draft.mode === "auto") {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={
          draft.mode === "auto"
            ? "What should the orchestrator achieve? It will split the work across subagents."
            : "Overall goal for synthesis (optional)…"
        }
        rows={draft.mode === "auto" ? 3 : 2}
        aria-label={draft.mode === "auto" ? "Orchestration goal" : "Overall goal (optional)"}
        className={cn(textareaClasses, "min-h-[4.5rem] px-1.5 py-0.5")}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          {config && (
            <Switch
              label={`Ask before starting: ${config.startApproval === "ask" ? "on" : "off"}`}
              checked={config.startApproval === "ask"}
              onToggle={() =>
                updateConfig({ startApproval: config.startApproval === "ask" ? "allow" : "ask" })
              }
              aria-label="Toggle asking before the orchestrator starts each task"
              title="Ask in this thread before the orchestrator starts each task"
              className="gap-2 px-1.5 py-0"
            />
          )}
        </div>
        <Button type="button" variant="primary" size="sm" disabled={!canSubmit} onClick={submit}>
          {isSubmitting ? "Starting…" : "Start orchestration"}
        </Button>
      </div>
    </Elevated>
  );
}
