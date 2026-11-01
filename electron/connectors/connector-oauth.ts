import { createServer, type Server } from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AUTH_CALLBACK_SUCCESS_HTML } from "../auth-callback-success.ts";
import type { ConnectorSecretData, ConnectorStore } from "./connector-store.ts";

type ConnectorOauth = NonNullable<ConnectorSecretData["oauth"]>;

interface ConnectorAuthOptions {
  connectorId: string;
  store: ConnectorStore;
  /** Set for a sign-in the user started: the loopback URL the server sends them back to. */
  redirectUrl?: string;
  state?: string;
  onRedirect?: (authorizationUrl: URL) => void;
}

export const CONNECTOR_CALLBACK_PATH = "/connectors/callback";

/**
 * The SDK's OAuth client for one connector, backed by the connector's sealed
 * secrets. With `redirectUrl` and `onRedirect` it runs a sign-in the user
 * started; without them it only uses and refreshes the tokens it has, and a
 * server that wants a new sign-in sets `needsSignIn` instead of opening a page.
 */
export class ConnectorAuthProvider implements OAuthClientProvider {
  /** Set when the server asked for a sign-in this provider can't do silently. */
  needsSignIn = false;

  /**
   * Registering a client needs the redirect URL of a sign-in the user started,
   * so only that provider has this. Without it the SDK stops before
   * registering, and `needsSignIn` (set in `clientInformation`) says why.
   */
  saveClientInformation?: (client: OAuthClientInformationMixed) => void;

  private readonly options: ConnectorAuthOptions;

  constructor(options: ConnectorAuthOptions) {
    this.options = options;
    if (options.onRedirect) {
      this.saveClientInformation = (client) =>
        this.saveOauth(() => ({ client, clientRedirectUrl: this.redirectUrl }));
    }
  }

  private get oauth(): ConnectorOauth {
    return this.options.store.secrets(this.options.connectorId).oauth ?? {};
  }

  private saveOauth(change: (oauth: ConnectorOauth) => Partial<ConnectorOauth>): void {
    this.options.store.updateSecrets(this.options.connectorId, (data) => ({
      ...data,
      oauth: { ...data.oauth, ...change(data.oauth ?? {}) },
    }));
  }

  /**
   * Always set: the SDK takes a missing one to mean a machine-to-machine
   * client and asks for tokens without a sign-in. Using saved tokens needs
   * only the URL the client was registered with.
   */
  get redirectUrl(): string {
    return (
      this.options.redirectUrl ??
      this.oauth.clientRedirectUrl ??
      `http://127.0.0.1${CONNECTOR_CALLBACK_PATH}`
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Pipper",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.options.state ?? "";
  }

  /**
   * The registered client, unless a sign-in is about to send the user back to
   * a different loopback port than it was registered with; then the SDK
   * registers again, which servers that support registration allow freely.
   */
  clientInformation(): OAuthClientInformationMixed | undefined {
    const { client, clientRedirectUrl } = this.oauth;
    if (!client) {
      // Without a registered client there are no tokens to use: only a sign-in
      // the user starts can register one (it needs the redirect URL).
      if (!this.options.onRedirect) this.needsSignIn = true;
      return undefined;
    }
    if (this.options.redirectUrl && clientRedirectUrl !== this.options.redirectUrl)
      return undefined;
    return client;
  }

  tokens(): OAuthTokens | undefined {
    return this.oauth.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.saveOauth((oauth) => ({
      // A refresh may leave the refresh token out; keep the one we had.
      tokens: { refresh_token: oauth.tokens?.refresh_token, ...tokens },
    }));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.options.onRedirect) this.options.onRedirect(authorizationUrl);
    else this.needsSignIn = true;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.saveOauth(() => ({ codeVerifier }));
  }

  codeVerifier(): string {
    const verifier = this.oauth.codeVerifier;
    if (!verifier) throw new Error("No sign-in is in progress for this connector.");
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    this.saveOauth(() => {
      switch (scope) {
        case "all":
          return {
            client: undefined,
            clientRedirectUrl: undefined,
            tokens: undefined,
            codeVerifier: undefined,
          };
        case "client":
          return { client: undefined, clientRedirectUrl: undefined };
        case "tokens":
          return { tokens: undefined };
        case "verifier":
          return { codeVerifier: undefined };
        default:
          return {};
      }
    });
  }
}

interface PendingSignIn {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Receives OAuth redirects on 127.0.0.1 (RFC 8252). It prefers the port it
 * used last, so a client registered with that redirect URL stays valid.
 */
export class LoopbackCallback {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly pending = new Map<string, PendingSignIn>();

  private readonly preferredPort: () => number | null;

  constructor(preferredPort: () => number | null = () => null) {
    this.preferredPort = preferredPort;
  }

  async start(): Promise<string> {
    if (this.port == null) {
      const server = createServer((req, res) => this.handle(req.url ?? "", res));
      this.port = await this.listen(server, this.preferredPort() ?? 0).catch(() =>
        this.listen(server, 0),
      );
      this.server = server;
    }
    return `http://127.0.0.1:${this.port}${CONNECTOR_CALLBACK_PATH}`;
  }

  get currentPort(): number | null {
    return this.port;
  }

  /** Resolves with the code from the redirect that carries `state`. */
  waitFor(state: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        reject(new Error("The sign-in wasn't finished in time."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(state, { resolve, reject, timer });
    });
  }

  cancel(state: string, reason = "The sign-in was cancelled."): void {
    const waiting = this.pending.get(state);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(state);
    waiting.reject(new Error(reason));
  }

  close(): void {
    for (const state of this.pending.keys()) this.cancel(state, "Pipper is quitting.");
    this.server?.close();
    this.server = null;
    this.port = null;
  }

  private listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not open the sign-in callback."));
      });
    });
  }

  private handle(rawUrl: string, res: import("node:http").ServerResponse): void {
    const url = new URL(rawUrl, "http://127.0.0.1");
    const state = url.searchParams.get("state") ?? "";
    const waiting = url.pathname === CONNECTOR_CALLBACK_PATH ? this.pending.get(state) : undefined;
    if (!waiting) {
      // Only a redirect for a sign-in Pipper started is accepted.
      res.writeHead(404, { "content-type": "text/plain" }).end("Unknown sign-in.");
      return;
    }
    this.pending.delete(state);
    clearTimeout(waiting.timer);
    const code = url.searchParams.get("code");
    if (!code) {
      const reason =
        url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code";
      waiting.reject(new Error(`The sign-in didn't finish: ${reason}`));
      res.writeHead(400, { "content-type": "text/plain" }).end(`Sign-in failed: ${reason}`);
      return;
    }
    waiting.resolve(code);
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(AUTH_CALLBACK_SUCCESS_HTML);
  }
}
