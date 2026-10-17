import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaretDown,
  Check,
  Copy,
  LockSimple,
  MagnifyingGlass,
  TerminalWindow,
} from "@phosphor-icons/react";
import {
  GITHUB_CLI_INSTALL_URL,
  GITHUB_CLI_LOGIN_COMMAND,
  type GitHubCliStatus,
  type GitHubRepository,
} from "../../contracts/github.ts";
import type { Project } from "../../contracts/projects.ts";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { SetupScriptEditor } from "@/components/setup-script-editor";
import { cn } from "@/lib/utils";

function SetupCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 p-3">
        <code className="min-w-0 flex-1 break-words text-xs leading-5 text-foreground">
          {command}
        </code>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopied(true);
              setError(null);
            } catch {
              setError("Could not copy. Select the command above and copy it manually.");
            }
          }}
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface GitHubProjectPickerProps {
  onCreated: (project: Project) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}

export function GitHubProjectPicker({
  onCreated,
  onBusyChange,
  disabled = false,
}: GitHubProjectPickerProps) {
  const [status, setStatus] = useState<GitHubCliStatus | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [query, setQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [cloning, setCloning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optional and tucked away, as in the local project form.
  const [scriptOpen, setScriptOpen] = useState(false);
  const [setupScript, setSetupScript] = useState("");
  const requestId = useRef(0);
  const checking = useRef(false);
  const cloningRef = useRef(false);

  const refresh = useCallback(async () => {
    if (checking.current || cloningRef.current) return;
    const id = ++requestId.current;
    checking.current = true;
    setIsLoading(true);
    setError(null);
    setStatus(null);
    setRepositories([]);
    try {
      if (!window.omni?.github)
        throw new Error("GitHub access is unavailable. Restart Pipper and try again.");
      const next = await window.omni.github.getStatus();
      if (id !== requestId.current) return;
      setStatus(next);
      if (next.state !== "ready") return;
      // Show the first page immediately, then continue fetching so search
      // includes organization and collaborator repositories beyond page one.
      let page = 1;
      while (true) {
        const result = await window.omni.github.listRepositories(page);
        if (id !== requestId.current) return;
        setRepositories((current) => {
          const byId = new Map(current.map((repo) => [repo.id, repo]));
          for (const repo of result.repositories) byId.set(repo.id, repo);
          return [...byId.values()];
        });
        if (!result.hasMore) break;
        page += 1;
      }
    } catch (err) {
      if (id === requestId.current)
        setError(err instanceof Error ? err.message : "Could not connect to GitHub.");
    } finally {
      if (id === requestId.current) {
        checking.current = false;
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      requestId.current += 1;
      checking.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const clone = async (repo: GitHubRepository) => {
    if (disabled || cloningRef.current) return;
    cloningRef.current = true;
    setCloning(repo.fullName);
    setError(null);
    onBusyChange(true);
    try {
      const project = await window.omni.github.cloneRepository(repo.fullName, {
        setupScript: setupScript.trim() ? setupScript : null,
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the repository.");
    } finally {
      cloningRef.current = false;
      setCloning(null);
      onBusyChange(false);
    }
  };

  const filtered = repositories.filter((repo) =>
    `${repo.fullName} ${repo.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight text-foreground">Select a repository</h1>
          <p className="text-xs leading-5 text-muted-foreground">
            {status?.state === "ready"
              ? `Connected as ${status.username}`
              : "Connect GitHub to bring a repository into Pipper."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {status?.state === "ready" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Search repositories"
              title="Search repositories"
              aria-expanded={isSearchOpen}
              active={isSearchOpen}
              disabled={cloning !== null || disabled}
              onClick={() => {
                setIsSearchOpen((current) => !current);
                setQuery("");
              }}
            >
              <MagnifyingGlass size={16} aria-hidden />
            </Button>
          )}
        </div>
      </header>

      {status?.state === "missing" && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1/40 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Install GitHub CLI</h2>
          </div>
          {status.installCommand && (
            <>
              <SetupCommand command={status.installCommand} label="install command" />
            </>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              try {
                await window.omni.shell.openExternal(GITHUB_CLI_INSTALL_URL);
              } catch {
                setError(
                  "Could not open installation instructions. Visit cli.github.com in your browser.",
                );
              }
            }}
          >
            Installation instructions
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void refresh();
            }}
          >
            I’ve installed it
          </Button>
        </div>
      )}

      {status?.state === "signed-out" && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1/40 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Sign in to GitHub</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              Run this in your terminal and finish signing in in your browser. Pipper will use your
              GitHub CLI account.
            </p>
          </div>
          <SetupCommand command={GITHUB_CLI_LOGIN_COMMAND} label="login command" />
          <Button type="button" variant="secondary" onClick={() => void refresh()}>
            I’ve signed in
          </Button>
        </div>
      )}

      {status?.state === "ready" && (
        <>
          {isSearchOpen && (
            <InputGroup className="w-full">
              <InputField
                label="Search repositories"
                icon={MagnifyingGlass}
                value={query}
                onChange={setQuery}
                placeholder="Repository or organization"
                disabled={cloning !== null || disabled}
                autoFocus
                index={0}
              />
            </InputGroup>
          )}
          <div
            className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto pr-1"
            aria-label="GitHub repositories"
          >
            {filtered.map((repo) => (
              <button
                key={repo.id}
                type="button"
                onClick={() => void clone(repo)}
                disabled={cloning !== null || disabled}
                className="group flex w-full items-start gap-3 rounded-xl border border-border/40 bg-surface-1/40 px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-medium">{repo.fullName}</span>
                </span>
                {repo.isPrivate && (
                  <LockSimple
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-label="Private repository"
                  />
                )}
              </button>
            ))}
            {!isLoading && filtered.length === 0 && !error && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {query.trim()
                  ? "No repositories match your search."
                  : "No repositories found for this account."}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setScriptOpen((open) => !open)}
              disabled={cloning !== null || disabled}
              aria-expanded={scriptOpen}
              data-pipper-id="github-project-setup-script-toggle"
              className={cn(
                "inline-flex items-center gap-1.5 self-start rounded-md px-3 py-1",
                "text-[12px] text-muted-foreground hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:pointer-events-none disabled:opacity-50 transition-colors",
              )}
            >
              <TerminalWindow size={14} aria-hidden />
              {setupScript.trim() ? "Setup script" : "Add setup script"}
              <span className="text-muted-foreground/60">· optional</span>
              <CaretDown
                size={12}
                weight="bold"
                className={cn("transition-transform", scriptOpen && "rotate-180")}
                aria-hidden
              />
            </button>
            {scriptOpen && (
              <div className="flex flex-col gap-1.5 px-0.5">
                <SetupScriptEditor
                  value={setupScript}
                  onChange={setSetupScript}
                  disabled={cloning !== null || disabled}
                  autoFocus
                  data-pipper-id="github-project-setup-script"
                />
                <p className="px-1 text-[11px] leading-4 text-muted-foreground">
                  Runs in each new workspace of the repository you pick, one command per line. You
                  can change it later in Settings → Projects.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {isLoading && (
        <p className="text-xs text-muted-foreground" role="status">
          {status?.state === "ready" ? "Loading repositories…" : "Checking GitHub CLI…"}
        </p>
      )}
      {cloning && (
        <p className="text-xs text-muted-foreground" role="status">
          Preparing {cloning}…
        </p>
      )}
      {error && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
          {!isLoading && (
            <Button
              type="button"
              variant="secondary"
              disabled={cloning !== null || disabled}
              onClick={() => void refresh()}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
