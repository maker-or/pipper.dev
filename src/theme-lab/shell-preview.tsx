import { useState } from "react";
import {
  ChatCircle,
  CheckCircle,
  GitBranch,
  GithubLogo,
  PaperPlaneRight,
  TerminalWindow,
} from "@phosphor-icons/react";
import { ConversationTurnIdentity } from "@/components/conversation-turn-identity";
import { ProjectTile } from "@/components/project-tile";
import { Button } from "@/components/ui/button";
import { TabItem, Tabs, TabsList } from "@/components/ui/tabs";
import { WorkspacePairedAction } from "@/components/workspace-paired-action";
import { WorkspaceStateSurface } from "@/components/workspace-state";
import { WorkspaceTabBar, type WorkspacePanelTab } from "@/components/workspace-tabs";
import { Elevated } from "@/lib/elevated";
import { WORKSPACE_STATE_META, type HeaderTone } from "@/lib/workspace-tone";
import { WorkspaceToneProvider } from "@/lib/workspace-tone-context";

const PREVIEW_PROJECTS = [
  { id: "pipper", name: "pipper", icon: "circle" },
  { id: "marketing-site", name: "marketing site", icon: "puffy" },
  { id: "api", name: "api", icon: "square" },
  { id: "docs", name: "docs", icon: "very-sunny" },
  { id: "mobile", name: "mobile", icon: "clover-4" },
  { id: "cli", name: "cli", icon: "arrow" },
  { id: "infra", name: "infra", icon: "flower" },
  { id: "design", name: "design", icon: "oval" },
  { id: "sdk", name: "sdk", icon: "pill" },
  { id: "blog", name: "blog", icon: "triangle" },
  { id: "web", name: "web", icon: "pentagon" },
  { id: "agents", name: "agents", icon: "cookie-9" },
  { id: "worker", name: "worker", icon: "gem" },
  { id: "spooky", name: "spooky", icon: "clover-8" },
  { id: "legacy", name: "legacy", icon: "bun" },
];

const CHANGES = [
  ["src/components/login-form.tsx", 42, 8],
  ["src/lib/auth-redirect.ts", 71, 30],
  ["src/lib/auth-redirect.test.ts", 15, 4],
] as const;

function LineTotals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-emerald-500">+{additions}</span>{" "}
      <span className="text-red-400">−{deletions}</span>
    </span>
  );
}

// Mirrors SessionPanel's header: the state's action beside the PR number, then the workspace rows.
function SessionHeader({ tone }: { tone: HeaderTone }) {
  const meta = WORKSPACE_STATE_META[tone];
  const hasPr = tone === "action" || tone === "ready" || tone === "merged";
  return (
    <WorkspaceStateSurface
      tone={tone}
      variant="header"
      className="flex shrink-0 flex-col gap-3 rounded-none px-4 pb-5 pt-4"
    >
      <div className="flex min-h-7 items-center">
        <WorkspacePairedAction
          tone={tone}
          primary={{
            label: tone === "merged" ? "Continue" : meta.action,
            title: meta.action,
            onClick: () => undefined,
          }}
          secondary={
            hasPr ? { label: 32, title: "Open pull request #32", onClick: () => undefined } : null
          }
        />
      </div>
      <div className="flex flex-col gap-0.5 text-[13px]">
        <div className="flex min-h-7 items-center gap-2.5">
          <ChatCircle size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground">fix-login-redirect</span>
        </div>
        <div className="flex min-h-7 items-center gap-2.5">
          <GitBranch size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground">pipper/fix-login</span>
        </div>
        <div className="flex min-h-7 items-center gap-2.5">
          <GithubLogo size={16} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">growx/pipper</span>
          <span className="text-muted-foreground">
            <LineTotals additions={128} deletions={42} />
          </span>
        </div>
      </div>
    </WorkspaceStateSurface>
  );
}

/**
 * The hybrid shell's layout and its git-state surfaces — project rail, tabs,
 * a thread and the session panel — built from the same components, with
 * sample content in place of the stores.
 */
export function ShellPreview({ tone }: { tone: HeaderTone }) {
  const [tab, setTab] = useState("thread-1");
  const [panelTab, setPanelTab] = useState<WorkspacePanelTab>("changes");
  return (
    <WorkspaceToneProvider tone={tone}>
      <div
        className="flex h-full min-h-0 overflow-hidden rounded-2xl bg-surface-1 text-foreground shadow-surface-1"
        data-pipper-id="theme-lab-preview"
      >
        {/* Project rail */}
        <aside className="flex w-[5.5rem] shrink-0 flex-col border-r border-border">
          <div className="h-3 shrink-0" />
          <div className="min-h-0 flex-1 overflow-hidden px-2">
            {/* The real rail tile, fed sample projects. */}
            <div className="flex flex-col gap-1">
              {PREVIEW_PROJECTS.map((project, index) => (
                <ProjectTile
                  key={project.id}
                  project={project}
                  selected={index === 0}
                  tone={tone}
                  tabIndex={-1}
                />
              ))}
            </div>
          </div>
        </aside>

        {/* Thread */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-center justify-center px-3">
            <Tabs className="min-w-0" value={tab} onValueChange={setTab}>
              <TabsList className="gap-1 p-1">
                <TabItem value="thread-1" label="Fix login redirect" icon={ChatCircle} />
                <TabItem value="thread-2" label="Refactor auth" icon={ChatCircle} />
                <TabItem value="terminal" label="zsh" icon={TerminalWindow} />
              </TabsList>
            </Tabs>
          </div>
          <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
            <div className="flex items-start justify-end gap-2">
              <Elevated
                offset={2}
                className="max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-5 text-foreground"
              >
                The login page loops back to itself after sign-in. Can you fix it?
              </Elevated>
              <ConversationTurnIdentity role="user" className="size-7" />
            </div>
            <div className="flex items-start gap-2">
              <ConversationTurnIdentity role="assistant" className="size-7" />
              <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-5 text-foreground">
                <p>
                  Found it: the redirect reads{" "}
                  <code className="rounded bg-muted px-1 font-mono text-[12px]">returnTo</code>{" "}
                  before the session cookie is set, so the guard sends you back to sign-in.
                </p>
                <Elevated
                  offset={1}
                  className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]"
                >
                  <CheckCircle size={16} className="text-muted-foreground" />
                  <span className="flex-1 text-muted-foreground">Ran bun run test</span>
                  <span>42 passed</span>
                </Elevated>
                <p className="text-muted-foreground">Edited 3 files. Ready for review.</p>
              </div>
            </div>
            <Elevated offset={2} className="mt-auto rounded-2xl p-3">
              <div className="min-h-12 text-[13px] text-muted-foreground">Ask for a follow-up…</div>
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  Claude Code
                </span>
                <Button size="icon-sm" variant="primary" className="ml-auto" aria-label="Send">
                  <PaperPlaneRight size={14} />
                </Button>
              </div>
            </Elevated>
          </div>
        </section>

        {/* Session panel */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border">
          <SessionHeader tone={tone} />
          <div className="px-4 pb-3">
            <WorkspaceTabBar tab={panelTab} onTabChange={setPanelTab} />
          </div>
          <div className="flex flex-col gap-1 px-4 py-1">
            {CHANGES.map(([path, additions, deletions]) => (
              <div key={path} className="flex min-h-7 items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-foreground">{path}</span>
                <LineTotals additions={additions} deletions={deletions} />
              </div>
            ))}
          </div>
        </aside>
      </div>
    </WorkspaceToneProvider>
  );
}
