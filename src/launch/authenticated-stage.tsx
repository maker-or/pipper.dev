import { useEffect, useState } from "react";
import { ArrowArcLeftIcon, CircleNotch, FolderIcon, GithubLogo } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabItem, TabPanel } from "@/components/ui/tabs";
import { ProjectShapeIcon } from "@/components/project-shape";
import { cn } from "@/lib/utils";
import { AddProjectForm } from "./add-project-form";
import { GitHubProjectPicker } from "./github-project-picker";
import { AmbientPixelField } from "@/components/ambient-pixel-field";
import { AgentSelector } from "@/components/agent-selector";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { SleeplessOnboarding } from "@/components/sleepless-onboarding";
import { trackOnboarding } from "./onboarding-analytics";

interface AuthenticatedStageProps {
  authUser: { name: string | null; email: string | null };
  projects: Project[];
  selectedId: string | null;
  isOpening: boolean;
  isLoading: boolean;
  loadError: string | null;
  handleOpen: (projectId: string) => void;
  handleProjectCreated: (project: Project) => void;
}

type LaunchStage = "agent" | "sleepless" | "shortcuts" | "list" | "add";

const AGENT_PICK_STORAGE_KEY = "pipper.launch.agentPicked";
const SLEEPLESS_ONBOARDING_STORAGE_KEY = "pipper.launch.sleeplessConfigured";
const SHORTCUTS_ONBOARDING_STORAGE_KEY = "pipper.launch.shortcutsShown";

function isOnboardingFlagSet(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}

function modifierSymbol(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)
    ? "⌘"
    : "Ctrl";
}

export function AuthenticatedStage({
  authUser,
  projects,
  selectedId,
  isOpening,
  isLoading,
  loadError,
  handleOpen,
  handleProjectCreated,
}: AuthenticatedStageProps) {
  const selectedAgentIds = useAgentRegistryStore((s) => s.selectedAgentIds);
  const loadAgents = useAgentRegistryStore((s) => s.load);
  const [projectSource, setProjectSource] = useState("local");
  const [isAddingProject, setIsAddingProject] = useState(false);

  const [stage, setStage] = useState<LaunchStage>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const stageParam = params.get("stage");
      if (stageParam === "add") {
        return "add";
      }
      if (stageParam === "agent") {
        return "agent";
      }
      if (stageParam === "sleepless") {
        return "sleepless";
      }
      if (stageParam === "shortcuts") {
        return "shortcuts";
      }
      // First-run funnel: agent → sleepless → shortcuts → list.
      // Returning users who completed an earlier step resume at the next unfinished one.
      if (!isOnboardingFlagSet(AGENT_PICK_STORAGE_KEY)) {
        return "agent";
      }
      if (!isOnboardingFlagSet(SLEEPLESS_ONBOARDING_STORAGE_KEY)) {
        return "sleepless";
      }
      if (!isOnboardingFlagSet(SHORTCUTS_ONBOARDING_STORAGE_KEY)) {
        return "shortcuts";
      }
    }
    return "list";
  });

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    trackOnboarding(`stage_${stage}_viewed`, "viewed", true);
  }, [stage]);

  return (
    <div className="h-screen w-screen relative overflow-hidden bg-surface-1 text-foreground flex items-center justify-center p-6">
      {/* Background */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <AmbientPixelField intensity={0.35} fadeStart={0.8} />
      </div>

      {/* Bounded Card — wider on agent onboarding for the two-column picker */}
      <div
        className={cn(
          "w-full z-10 rounded-2xl p-8 flex max-h-full flex-col gap-6 overflow-y-auto",
          stage === "agent"
            ? "max-w-3xl"
            : stage === "sleepless" || stage === "shortcuts"
              ? "max-w-xl"
              : "max-w-md",
        )}
      >
        {stage === "agent" ? (
          <>
            <header className="flex flex-col gap-2"></header>
            <AgentSelector
              showContinue
              onContinue={() => {
                trackOnboarding("agent_pick_completed", "complete", true);
                try {
                  sessionStorage.setItem(AGENT_PICK_STORAGE_KEY, "1");
                  if (sessionStorage.getItem(SLEEPLESS_ONBOARDING_STORAGE_KEY) !== "1") {
                    setStage("sleepless");
                    return;
                  }
                  if (sessionStorage.getItem(SHORTCUTS_ONBOARDING_STORAGE_KEY) !== "1") {
                    try {
                      sessionStorage.setItem(SHORTCUTS_ONBOARDING_STORAGE_KEY, "1");
                    } catch {
                      // ignore
                    }
                  }
                } catch {
                  // ignore
                }
                setStage("list");
              }}
            />
          </>
        ) : stage === "sleepless" ? (
          <SleeplessOnboarding
            onComplete={(action = "continued") => {
              trackOnboarding(
                action === "enabled"
                  ? "sleepless_enabled"
                  : action === "skipped"
                    ? "sleepless_skipped"
                    : "sleepless_completed",
                action === "skipped" ? "skipped" : "complete",
                action !== "skipped",
              );
              try {
                sessionStorage.setItem(SLEEPLESS_ONBOARDING_STORAGE_KEY, "1");
              } catch {
                // ignore
              }
              if (!isOnboardingFlagSet(SHORTCUTS_ONBOARDING_STORAGE_KEY)) {
                setStage("shortcuts");
                return;
              }
              setStage("list");
            }}
          />
        ) : stage === "shortcuts" ? (
          <div className="flex flex-col gap-5">
            <header className="flex flex-col gap-1">
              <h1 className="text-xl font-bold tracking-tight">Keyboard shortcuts</h1>
              <p className="text-xs text-muted-foreground">A few moves worth knowing.</p>
            </header>
            <ul className="flex flex-col gap-2">
              {[
                { action: "New thread", keys: `${modifierSymbol()}T` },
                { action: "New terminal", keys: modifierSymbol() === "⌘" ? "⌘⇧T" : "Ctrl+Shift+T" },
                { action: "Close tab", keys: `${modifierSymbol()}W` },
                { action: "Switch tabs", keys: `${modifierSymbol()}1–9` },
              ].map(({ action, keys }) => (
                <li
                  key={action}
                  className="flex items-center gap-3.5 rounded-xl border border-border/50 bg-surface-1/40 py-2.5 pl-3 pr-3.5"
                >
                  <kbd className="inline-flex h-8 min-w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 px-2.5 font-sans text-sm font-medium text-foreground">
                    {keys}
                  </kbd>
                  <span className="text-sm text-foreground">{action}</span>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              size="md"
              onClick={() => {
                trackOnboarding("shortcuts_completed", "complete", true);
                try {
                  sessionStorage.setItem(SHORTCUTS_ONBOARDING_STORAGE_KEY, "1");
                } catch {
                  // ignore
                }
                setStage("list");
              }}
            >
              Continue
            </Button>
          </div>
        ) : (
          <Tabs
            value={projectSource}
            onValueChange={setProjectSource}
            className="flex flex-col gap-6"
          >
            <TabsList aria-label="Project source" className="w-full">
              <TabItem
                value="local"
                label="Local"
                icon={FolderIcon}
                className="flex-1 justify-center"
                disabled={isAddingProject || isOpening}
              />
              <TabItem
                value="github"
                label="GitHub"
                icon={GithubLogo}
                className="flex-1 justify-center"
                disabled={isAddingProject || isOpening}
              />
            </TabsList>
            <TabPanel value="local" className="flex flex-col gap-6">
              {stage === "list" ? (
                <>
                  <header className="flex flex-col gap-1 pb-2 border-b border-border">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h1 className="text-xl font-bold text-foreground tracking-tight truncate">
                          Welcome, {authUser.name ?? authUser.email ?? "User"}!
                        </h1>
                        <p className="text-xs text-muted-foreground">Select a project to start</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 text-[11px]"
                        data-pipper-id="change-agent-button"
                        onClick={() => {
                          trackOnboarding("agent_repick_started", "viewed", true);
                          setStage("agent");
                        }}
                      >
                        {selectedAgentIds.length > 0
                          ? `Change agents (${selectedAgentIds.length})`
                          : "Select agents"}
                      </Button>
                    </div>
                  </header>

                  <div className="flex flex-col gap-4">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Recent Projects
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          trackOnboarding("add_project_started", "viewed", true);
                          setStage("add");
                        }}
                        leadingIcon={FolderIcon}
                        className="h-8 text-xs"
                      >
                        Add Project
                      </Button>
                    </div>

                    <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto pr-1">
                      {loadError != null && (
                        <p className="py-2 text-sm text-destructive" role="alert">
                          {loadError}
                        </p>
                      )}

                      {isLoading && loadError == null && (
                        <p className="py-4 text-sm text-muted-foreground flex items-center gap-2 justify-center">
                          <CircleNotch className="animate-spin text-primary" size={16} />
                          Loading projects…
                        </p>
                      )}

                      {!isLoading && loadError == null && projects.length === 0 && (
                        <p className="py-8 text-center text-sm text-muted-foreground border border-dashed border-border rounded-xl bg-surface-1/40">
                          No projects yet. Add one to get started.
                        </p>
                      )}

                      {!isLoading &&
                        loadError == null &&
                        projects.map((project) => {
                          const isActive = selectedId === project.id;
                          return (
                            <button
                              key={project.id}
                              type="button"
                              onClick={() => handleOpen(project.id)}
                              disabled={isOpening}
                              className={cn(
                                "group flex items-center gap-3 w-full",
                                "px-3 py-2.5 rounded-xl text-left text-sm",
                                "text-foreground bg-surface-1/40 border border-border/40",
                                "hover:bg-accent hover:border-accent",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "disabled:opacity-60 disabled:cursor-not-allowed",
                                "transition-all duration-200",
                                isActive && "bg-accent border-accent",
                              )}
                            >
                              <ProjectShapeIcon project={project} className="size-6 shrink-0" />
                              <span className="flex-1 truncate font-medium">{project.name}</span>
                              <ArrowArcLeftIcon
                                className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                strokeWidth={1.75}
                              />
                            </button>
                          );
                        })}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <AddProjectForm
                    disabled={isOpening}
                    onBusyChange={setIsAddingProject}
                    onBack={() => {
                      trackOnboarding("add_project_abandoned", "skipped", false);
                      setStage("list");
                    }}
                    onCreated={(project) => {
                      trackOnboarding("add_project_completed", "complete", true);
                      handleProjectCreated(project);
                    }}
                  />
                </>
              )}
            </TabPanel>
            <TabPanel value="github">
              <GitHubProjectPicker
                disabled={isOpening}
                onBusyChange={setIsAddingProject}
                onCreated={(project) => {
                  trackOnboarding("github_project_opened", "complete", true);
                  handleProjectCreated(project);
                }}
              />
            </TabPanel>
          </Tabs>
        )}
      </div>
    </div>
  );
}
