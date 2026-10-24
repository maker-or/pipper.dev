import type { Project } from "./projects.ts";

export type GitHubCliStatus = {
  state: "missing" | "signed-out" | "ready";
  username: string | null;
  installCommand: string | null;
};

export interface GitHubRepository {
  id: number;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
}

export interface GitHubRepositoryPage {
  repositories: GitHubRepository[];
  hasMore: boolean;
}

export interface GitHubApi {
  getStatus: () => Promise<GitHubCliStatus>;
  listRepositories: (page?: number) => Promise<GitHubRepositoryPage>;
  /**
   * Clone (or reopen) a repository as a project. A non-blank `setupScript`
   * becomes the project's setup script; blank leaves any existing one alone.
   */
  cloneRepository: (
    fullName: string,
    options?: { setupScript?: string | null },
  ) => Promise<Project>;
}

export const GITHUB_CLI_INSTALL_URL = "https://cli.github.com/";
export const GITHUB_CLI_LOGIN_COMMAND =
  "gh auth login --hostname github.com --web --git-protocol https";
