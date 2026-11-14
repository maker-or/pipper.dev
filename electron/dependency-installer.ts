import { exec, execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function isWindows(): boolean {
  return process.platform === "win32";
}

function pathDelimiter(): string {
  return isWindows() ? ";" : ":";
}

/** The newest nvm-installed Node's bin folder, if nvm is used. */
function nvmNodeBin(home: string): string | null {
  const root = join(process.env.NVM_DIR ?? join(home, ".nvm"), "versions", "node");
  try {
    const versions = readdirSync(root)
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const pa = a.slice(1).split(".").map(Number);
        const pb = b.slice(1).split(".").map(Number);
        return pb[0]! - pa[0]! || pb[1]! - pa[1]! || pb[2]! - pa[2]!;
      });
    return versions[0] ? join(root, versions[0], "bin") : null;
  } catch {
    return null;
  }
}

function getStandardPaths(): string[] {
  const home = os.homedir();
  const shared = [join(home, ".local", "bin"), join(home, ".bun", "bin")];
  if (isWindows()) {
    const appData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roamingAppData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
      join(appData, "Microsoft", "WinGet", "Links"),
      join(appData, "Programs", "Git", "cmd"),
      join(appData, "Programs", "Git", "bin"),
      join(home, "scoop", "shims"),
      // Node's installer and npm's global bin (where `npm i -g` CLIs land).
      join(programFiles, "nodejs"),
      join(roamingAppData, "npm"),
      ...shared,
    ];
  }
  // Node version managers keep node/npx outside the system folders; the login
  // shell PATH (shell-path.ts) covers them too, these are the fallback when
  // the shell can't be read.
  const nodeManagers = [
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    nvmNodeBin(home),
  ].filter((dir): dir is string => Boolean(dir));
  // /usr/bin + /bin last: GUI launches (Finder/dock) can strip PATH down to
  // almost nothing, and without these even system git won't resolve.
  return ["/opt/homebrew/bin", "/usr/local/bin", ...shared, ...nodeManagers, "/usr/bin", "/bin"];
}

/** Add GUI-visible locations for Git and user project tools to PATH. */
export function prependStandardPaths(): void {
  const delimiter = pathDelimiter();
  const paths = process.env.PATH?.split(delimiter) ?? [];
  for (const candidate of getStandardPaths().reverse()) {
    if (!paths.includes(candidate)) paths.unshift(candidate);
  }
  process.env.PATH = paths.join(delimiter);
}

export async function checkGit(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git --version");
    return stdout.toLowerCase().includes("git version");
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    if (isWindows()) await execFileAsync("where.exe", [command], { windowsHide: true });
    else await execAsync(`command -v ${command}`);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort first-run Git help. Project runtimes are the user's responsibility. */
export async function installGit(): Promise<void> {
  if (await checkGit()) return;

  if (!isWindows() && (await commandExists("brew"))) {
    await execAsync("brew install git");
    prependStandardPaths();
    if (await checkGit()) return;
  }

  if (isWindows() && (await commandExists("winget"))) {
    await execFileAsync(
      "winget",
      [
        "install",
        "--id",
        "Git.Git",
        "-e",
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
      ],
      { windowsHide: true },
    );
    prependStandardPaths();
    if (await checkGit()) return;
  }

  throw new Error("Git is required for projects. Install Git and restart Pipper.");
}
