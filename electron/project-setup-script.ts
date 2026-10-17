import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.ts";
import { resolveInstallCommand } from "./worktree-manager.ts";

/**
 * Per-project setup script: shell commands, one per line, that Pipper runs in
 * every new workspace of the project (from the workspace folder). It lives in
 * Pipper's own database, not in the repository. When a project has one it
 * replaces the automatic JavaScript dependency install.
 */

/** Generous, but keeps a pasted blob from bloating the settings table. */
export const MAX_SETUP_SCRIPT_LENGTH = 20_000;

/** Normalize line endings and trim; an empty script means "none". */
export function normalizeSetupScript(script: string | null | undefined): string | null {
  if (script == null) return null;
  const normalized = script.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  if (normalized.length > MAX_SETUP_SCRIPT_LENGTH) {
    throw new Error(`Setup script is too long (max ${MAX_SETUP_SCRIPT_LENGTH} characters).`);
  }
  return normalized;
}

export function getProjectSetupScript(projectId: string): string | null {
  const row = getDb()
    .prepare("SELECT setup_script FROM project_settings WHERE project_id = ?")
    .get(projectId) as { setup_script: string | null } | undefined;
  return row?.setup_script ?? null;
}

/** Save (or clear, with null/blank) a project's setup script. Returns what was stored. */
export function setProjectSetupScript(projectId: string, script: string | null): string | null {
  const normalized = normalizeSetupScript(script);
  const db = getDb();
  if (normalized === null) {
    db.prepare("DELETE FROM project_settings WHERE project_id = ?").run(projectId);
    return null;
  }
  db.prepare(
    `INSERT INTO project_settings (project_id, setup_script, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET setup_script = excluded.setup_script,
       updated_at = excluded.updated_at`,
  ).run(projectId, normalized, Date.now());
  return normalized;
}

/**
 * A starting point for the setup script, detected from the project's files.
 * Only a suggestion shown in the editor; nothing runs unless the user saves it.
 */
export function suggestSetupScript(projectPath: string): string | null {
  const has = (file: string) => existsSync(join(projectPath, file));
  const install = resolveInstallCommand(projectPath);
  if (install) return [install.command, ...install.args].join(" ");
  if (has("uv.lock")) return "uv sync";
  if (has("poetry.lock")) return "poetry install";
  if (has("Pipfile.lock") || has("Pipfile")) return "pipenv install";
  if (has("Cargo.toml")) return "cargo fetch";
  if (has("go.mod")) return "go mod download";
  if (has("Gemfile")) return "bundle install";
  if (has("composer.json")) return "composer install";
  if (has("mix.exs")) return "mix deps.get";
  if (has("pubspec.yaml")) return "flutter pub get";
  if (has("Package.swift")) return "swift package resolve";
  return null;
}
