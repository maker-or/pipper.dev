import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GitHubCliStatus, GitHubRepositoryPage } from "../contracts/github.ts";
import { shapeForSeed, type Project } from "../contracts/projects.ts";
import { ghBinary } from "./git-workspace.ts";
import { createProject, listProjects } from "./projects.ts";
import { foreignGitEnv, gitBinary } from "./worktree-manager.ts";

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 50;
const clonesInFlight = new Map<string, Promise<Project>>();

function cliEnv(): NodeJS.ProcessEnv {
  const env = foreignGitEnv();
  // gh itself invokes git; Dock/Finder launches may omit its install directory.
  env.PATH = [dirname(gitBinary()), dirname(ghBinary()), env.PATH].filter(Boolean).join(delimiter);
  env.GH_HOST = "github.com";
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function gh(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(ghBinary(), args, {
    cwd: homedir(),
    env: cliEnv(),
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function getGitHubCliStatus(): Promise<GitHubCliStatus> {
  const installCommand =
    process.platform === "darwin"
      ? "brew install gh"
      : process.platform === "win32"
        ? "winget install --id GitHub.cli --exact"
        : null;
  const base = { username: null, installCommand };
  try {
    // Deliberately bypass the workspace panel's availability cache so a new
    // installation is detected immediately when onboarding is refreshed.
    await gh(["--version"], 5_000);
  } catch {
    return { ...base, state: "missing" };
  }
  try {
    const username = await gh(["api", "user", "--hostname", "github.com", "--jq", ".login"]);
    if (!username || username === "null") throw new Error("Missing GitHub user.");
    return { ...base, state: "ready", username };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/gh auth login|not logged|authentication|HTTP 401|Bad credentials/i.test(stderr)) {
      return { ...base, state: "signed-out" };
    }
    // A network failure is not evidence that the user has signed out.
    throw new Error("Could not connect to GitHub. Check your connection and try again.");
  }
}

export async function listGitHubRepositories(page = 1): Promise<GitHubRepositoryPage> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new Error("Invalid repository page.");
  }
  try {
    const output = await gh([
      "api",
      `user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=${PAGE_SIZE}&page=${page}`,
      "--hostname",
      "github.com",
    ]);
    const rows = JSON.parse(output) as Array<{
      id: number;
      full_name: string;
      description: string | null;
      private: boolean;
    }>;
    return {
      repositories: rows.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        description: repo.description,
        isPrivate: repo.private,
      })),
      hasMore: rows.length === PAGE_SIZE,
    };
  } catch {
    throw new Error("Could not load repositories. Check your connection and GitHub CLI login.");
  }
}

function repositoryName(input: string): string {
  // This value becomes both a CLI argument and managed path components.
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(input)
  ) {
    throw new Error("Choose a valid GitHub repository.");
  }
  const [owner, name] = input.split("/");
  if (name === "." || name === "..") throw new Error("Choose a valid GitHub repository.");
  return `${owner}/${name}`;
}

async function verifyCheckout(path: string, fullName: string): Promise<void> {
  try {
    const options = { cwd: path, env: cliEnv(), encoding: "utf8" as const, timeout: 10_000 };
    const { stdout: root } = await execFileAsync(
      gitBinary(),
      ["rev-parse", "--show-toplevel"],
      options,
    );
    const { stdout: origin } = await execFileAsync(
      gitBinary(),
      ["remote", "get-url", "origin"],
      options,
    );
    const match = origin
      .trim()
      .match(
        /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i,
      );
    if (
      (await realpath(root.trim())) !== (await realpath(path)) ||
      match?.[1].toLowerCase() !== fullName.toLowerCase()
    ) {
      throw new Error("Checkout does not match.");
    }
  } catch {
    throw new Error(
      `The saved checkout does not match ${fullName}. Move ${path} aside and try again.`,
    );
  }
}

async function cloneAndRegister(fullName: string): Promise<Project> {
  const [owner, name] = fullName.toLowerCase().split("/");
  const parent = join(homedir(), ".pipper", "repos", "github.com", owner);
  const destination = join(parent, name);
  if (existsSync(destination)) {
    await verifyCheckout(destination, fullName);
  } else {
    await mkdir(parent, { recursive: true });
    // Publish a checkout only after cloning succeeds. Failed clones can be
    // retried without mistaking partial files for an existing repository.
    const staging = await mkdtemp(join(parent, ".pipper-clone-"));
    try {
      const checkout = join(staging, "repo");
      await gh(["repo", "clone", fullName, checkout, "--no-upstream"], 10 * 60_000);
      await verifyCheckout(checkout, fullName);
      await rename(checkout, destination);
    } catch {
      throw new Error(
        "Could not clone the repository. Check your connection, Git installation, and repository access, then try again.",
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  const path = await realpath(destination);
  for (const project of listProjects()) {
    // Local projects can point through symlinks, including on macOS's /var.
    // A stale project path should not prevent opening another checkout.
    const projectPath = await realpath(project.path).catch(() => null);
    if (projectPath === path) return project;
  }
  return createProject({ name: fullName, path, icon: shapeForSeed(fullName) });
}

export function cloneGitHubRepository(input: string): Promise<Project> {
  const fullName = repositoryName(input);
  const key = fullName.toLowerCase();
  const existing = clonesInFlight.get(key);
  if (existing) return existing;
  const task = cloneAndRegister(fullName).finally(() => clonesInFlight.delete(key));
  clonesInFlight.set(key, task);
  return task;
}
