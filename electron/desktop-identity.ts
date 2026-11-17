import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A sign-in started longer ago than this can no longer complete. */
const SIGN_IN_STATE_TTL_MS = 15 * 60_000;
/** Pending sign-ins remembered at once (the user may click sign-in twice). */
const MAX_PENDING_STATES = 4;
const LAPTOP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** OS-backed encryption (Electron safeStorage); absent = keep secrets in memory only. */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/**
 * This install's identity toward pipper.dev:
 * - a random laptop id, created once, that scopes the laptop credential;
 * - one-time `state` values that bind a sign-in callback to a sign-in this
 *   app actually started (so a stray or malicious callback can't sign the
 *   app into someone else's account);
 * - the signed laptop credential pipper.dev issues, stored only encrypted.
 */
export class DesktopIdentity {
  private readonly dir: string;
  private readonly box: SecretBox | null;
  private readonly pending = new Map<string, number>();
  private memoryCredential: string | null = null;

  constructor(options: { dir: string; secretBox?: SecretBox | null }) {
    this.dir = options.dir;
    this.box = options.secretBox ?? null;
  }

  private get credentialPath(): string {
    return join(this.dir, "laptop-credential.bin");
  }

  laptopId(): string {
    const file = join(this.dir, "laptop-id");
    try {
      const saved = readFileSync(file, "utf8").trim();
      if (LAPTOP_ID_RE.test(saved)) return saved;
    } catch {
      // first run
    }
    const id = randomUUID();
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  }

  /** New one-time state for a sign-in about to open in the browser. */
  beginSignIn(now = Date.now()): string {
    for (const [state, at] of this.pending) {
      if (now - at > SIGN_IN_STATE_TTL_MS) this.pending.delete(state);
    }
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, now);
    while (this.pending.size > MAX_PENDING_STATES) {
      this.pending.delete(this.pending.keys().next().value!);
    }
    return state;
  }

  /** True once for a state this app issued and that hasn't expired. */
  consumeState(state: string | null, now = Date.now()): boolean {
    if (!state) return false;
    const at = this.pending.get(state);
    this.pending.delete(state);
    return at !== undefined && now - at <= SIGN_IN_STATE_TTL_MS;
  }

  saveCredential(credential: string): void {
    this.memoryCredential = credential;
    if (!this.box?.available()) {
      console.warn("[Identity] OS encryption unavailable; laptop credential kept in memory only.");
      // Never leave a previous (possibly other account's) credential on disk
      // to be loaded on the next launch in place of this one.
      rmSync(this.credentialPath, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.credentialPath, this.box.encrypt(credential), { mode: 0o600 });
  }

  credential(): string | null {
    if (this.memoryCredential) return this.memoryCredential;
    // No file means nothing to decrypt: don't ask the keychain (a macOS prompt).
    if (!existsSync(this.credentialPath) || !this.box?.available()) return null;
    try {
      this.memoryCredential = this.box.decrypt(readFileSync(this.credentialPath));
      return this.memoryCredential;
    } catch {
      return null;
    }
  }

  clearCredential(): void {
    this.memoryCredential = null;
    rmSync(this.credentialPath, { force: true });
  }
}

/** Add the desktop handoff params pipper.dev's /auth expects. */
export function withSignInParams(
  url: string,
  params: { returnTo: string; state: string; laptopId: string },
): string {
  const next = new URL(url);
  next.searchParams.set("return_to", params.returnTo);
  next.searchParams.set("state", params.state);
  next.searchParams.set("laptop_id", params.laptopId);
  return next.toString();
}
