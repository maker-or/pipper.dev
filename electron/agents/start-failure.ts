/**
 * Why an agent failed to start, as a small fixed set of categories safe to
 * send to analytics. The raw error and stderr can hold paths, usernames and
 * tokens, so they never leave the machine; only the category does.
 *
 * Order matters: a package-install failure usually surfaces as "the process
 * exited", and an exit can carry an auth message, so the more specific causes
 * are checked first.
 */
export type AgentStartFailureReason =
  /** The command or package isn't there (ENOENT, not on PATH). */
  | "not_installed"
  /** npm/npx could not install or run the package, or it installed broken. */
  | "package_install_failed"
  /** The agent wants a sign-in or a key. */
  | "auth_required"
  /** No reply within the handshake budget. */
  | "timeout"
  /** The process exited or closed its pipes before finishing the handshake. */
  | "exited_early"
  /** The agent answered, but with a JSON-RPC error. */
  | "protocol_error"
  | "unknown";

export interface AgentStartFailureInput {
  error: unknown;
  /** Tail of the agent's stderr, read locally only. */
  stderr?: string;
  exitCode?: number | null;
}

const PACKAGE_INSTALL =
  /\bnpm (?:error|ERR!)|\bE(?:BADDEVENGINES|NOTFOUND|AI_AGAIN|CONNRESET|404|INTEGRITY|ACCES)\b|Missing optional dependency|Cannot find module|ERR_MODULE_NOT_FOUND/;
const NOT_INSTALLED =
  /\bENOENT\b|command not found|not installed|is not recognized as an internal or external command|no such file or directory/i;
const AUTH_REQUIRED =
  /auth(?:entication)?[\s_-]*required|not (?:logged|signed) in|please (?:log|sign) in|unauthori[sz]ed|\b401\b|\b403\b|invalid api key|api key (?:is )?(?:missing|not set)/i;
const TIMEOUT = /timed out|timeout/i;
const EXITED =
  /exited|connection closed|before responding|EPIPE|stream (?:closed|ended)|process (?:died|exited)/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause ? `${error.message}\n${messageOf(cause)}` : error.message;
  }
  return typeof error === "string" ? error : "";
}

function isRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && code <= -32000 && code >= -32768;
}

export function classifyAgentStartFailure(input: AgentStartFailureInput): AgentStartFailureReason {
  const message = messageOf(input.error);
  const text = `${message}\n${input.stderr ?? ""}`;
  if (PACKAGE_INSTALL.test(text)) return "package_install_failed";
  if (NOT_INSTALLED.test(text)) return "not_installed";
  if (AUTH_REQUIRED.test(text)) return "auth_required";
  if (TIMEOUT.test(message)) return "timeout";
  if (isRpcError(input.error)) return "protocol_error";
  if (EXITED.test(message) || (input.exitCode != null && input.exitCode !== 0)) {
    return "exited_early";
  }
  return "unknown";
}
