import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LockSimple, MagnifyingGlass } from "@phosphor-icons/react";
import {
  GITHUB_CLI_INSTALL_URL,
  GITHUB_CLI_LOGIN_COMMAND,
  type GitHubCliStatus,
  type GitHubRepository,
} from "../../contracts/github.ts";
import type { Project } from "../../contracts/projects.ts";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";

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
  /** The search toggle lives in the launch header; the picker only renders the field. */
  isSearchOpen?: boolean;
  /** Reports the connected GitHub username (null when not signed in) for the launch header. */
  onUsernameChange?: (username: string | null) => void;
}

export function GitHubProjectPicker({
  onCreated,
  onBusyChange,
  disabled = false,
  isSearchOpen = false,
  onUsernameChange,
}: GitHubProjectPickerProps) {
  const [status, setStatus] = useState<GitHubCliStatus | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [query, setQuery] = useState("");
  const [searchWasOpen, setSearchWasOpen] = useState(isSearchOpen);
  const [isLoading, setIsLoading] = useState(true);
  const [cloning, setCloning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // Toggling search from the header always starts from an empty query.
  if (searchWasOpen !== isSearchOpen) {
    setSearchWasOpen(isSearchOpen);
    setQuery("");
  }

  // `status` is cleared to null during each recheck; only report settled
  // results so the header name does not flicker on window focus.
  useEffect(() => {
    if (status) onUsernameChange?.(status.state === "ready" ? status.username : null);
  }, [status, onUsernameChange]);

  const clone = async (repo: GitHubRepository) => {
    if (disabled || cloningRef.current) return;
    cloningRef.current = true;
    setCloning(repo.fullName);
    setError(null);
    onBusyChange(true);
    try {
      const project = await window.omni.github.cloneRepository(repo.fullName);
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
