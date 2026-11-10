import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "#/client/auth";
import { PreconditionError } from "#/client/errors";
import { TOKEN_FILE_VERSION, type StoredTokens, type TokenStore } from "#/client/tokens";
import { API_BASE_URL, effectiveScopes, type Config } from "#/config";

export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** How long a started login keeps its loopback port open for the callback. */
export const LOGIN_TIMEOUT_MS = 300_000;

const base64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type PkcePair = { verifier: string; challenge: string };

/** PKCE S256. 32 random bytes base64url-encode to 43 characters, the spec minimum. */
export const createPkcePair = (random: (n: number) => Buffer = randomBytes): PkcePair => {
  const verifier = base64url(random(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

export const buildAuthorizeUrl = (opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(" "),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    // Without access_type=offline Google returns no refresh token, and without
    // prompt=consent it returns one only on the very first consent — so a
    // second login (new scopes, another channel) would silently come back
    // with an access token that dies in an hour.
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

/** Constant-time compare, so a mismatched state cannot be probed byte by byte. */
const statesMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

/**
 * Only the two fields RFC 6749 defines are quoted from an error body: the
 * request carried the client secret and the refresh token, and an arbitrary
 * body echoed into a tool result could round-trip either into the transcript.
 */
const oauthDetail = (text: string): { error?: string; description?: string } => {
  try {
    const rec = JSON.parse(text) as Record<string, unknown>;
    return {
      ...(typeof rec.error === "string" ? { error: rec.error } : {}),
      ...(typeof rec.error_description === "string" ? { description: rec.error_description } : {}),
    };
  } catch {
    return {};
  }
};

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.code = code;
  }
}

export type OAuthClient = {
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  revoke(token: string): Promise<boolean>;
};

export const createOAuthClient = (config: Config, fetchImpl: typeof fetch = fetch): OAuthClient => {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) {
    throw new PreconditionError("YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are required.", {
      remedy: "Call youtube_auth_status for the setup steps.",
    });
  }

  const post = async (body: URLSearchParams): Promise<TokenResponse> => {
    // Google's Desktop clients have a secret that is not really secret (it
    // ships inside every installed app), but the token endpoint still demands
    // it alongside the PKCE verifier.
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const { error, description } = oauthDetail(text);
      throw new OAuthError(
        `Google rejected the OAuth token request: HTTP ${res.status}` +
          (error ? ` — ${error}${description ? `: ${description}` : ""}` : ""),
        error,
      );
    }
    return JSON.parse(text) as TokenResponse;
  };

  return {
    exchangeCode: (code, verifier, redirectUri) =>
      post(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      ),
    refresh: (refreshToken) =>
      post(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })),
    revoke: async (token) => {
      try {
        const res = await fetchImpl(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
};

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>youtube-mcp</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1>${title}</h1><p>${body}</p></body>`;

const SUCCESS_PAGE = page(
  "Signed in",
  "youtube-mcp stored your token. You can close this tab and return to the conversation.",
);
const FAILURE_PAGE = page("Sign-in failed", "Ask the agent for the reason (youtube_auth_status).");

type Listener = {
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
};

/**
 * Listen on an EPHEMERAL loopback port for exactly one callback. Unlike X or
 * Reddit, Google's Desktop app clients accept any port on 127.0.0.1 without
 * registering it, so a fixed port (and its EADDRINUSE) buys nothing here.
 */
const listenForCallback = async (state: string, timeoutMs: number): Promise<Listener> => {
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end("Not found");
      return;
    }
    // State first, before `error` is even looked at: any web page can make the
    // browser GET 127.0.0.1:<port>/?error=x with an image tag, and that must
    // not be able to cancel a login in progress.
    if (!statesMatch(url.searchParams.get("state") ?? "", state)) {
      res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_PAGE);
      return;
    }
    const error = url.searchParams.get("error");
    const returned = url.searchParams.get("code");
    if (error || !returned) {
      res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_PAGE);
      settle.reject(
        new Error(
          error === "access_denied"
            ? "The Google consent screen was cancelled or denied."
            : `Google returned no authorization code${error ? ` (${error})` : ""}.`,
        ),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_PAGE);
    settle.resolve(returned);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  const timer = setTimeout(() => {
    settle.reject(
      new Error(
        `No callback arrived within ${Math.round(timeoutMs / 1000)}s. Call youtube_auth_login again.`,
      ),
    );
  }, timeoutMs);
  timer.unref?.();

  const close = (): void => {
    clearTimeout(timer);
    server.close();
    // A no-op once settled; otherwise a cancelled login rejects instead of
    // leaving its `done` pending forever.
    settle.reject(new Error("This login was cancelled (a newer youtube_auth_login started)."));
  };
  void code.finally(close).catch(() => {});

  return { redirectUri: `http://127.0.0.1:${port}`, code, close };
};

/** Resolve which channel the token acts as. Null when the account has none. */
export const fetchOwnChannel = async (
  fetchImpl: typeof fetch,
  accessToken: string,
  timeoutMs: number,
): Promise<{ id: string; title: string } | null> => {
  const res = await fetchImpl(`${API_BASE_URL}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { items?: { id?: string; snippet?: { title?: string } }[] };
  const item = body.items?.[0];
  return item?.id ? { id: item.id, title: item.snippet?.title ?? "" } : null;
};

export const toStoredTokens = (
  res: TokenResponse,
  opts: {
    clientId: string;
    requestedScopes: string[];
    now: number;
    refreshToken: string;
    channel?: { id: string; title: string } | null;
  },
): StoredTokens => ({
  version: TOKEN_FILE_VERSION,
  clientId: opts.clientId,
  // Google echoes the scopes actually granted. A user can untick one on the
  // consent screen, so this — not what was asked for — is the truth.
  scopes: res.scope ? res.scope.split(/\s+/).filter(Boolean) : opts.requestedScopes,
  accessToken: res.access_token,
  refreshToken: res.refresh_token ?? opts.refreshToken,
  expiresAt: opts.now + (res.expires_in ?? 3600) * 1000,
  obtainedAt: opts.now,
  ...(opts.channel ? { channelId: opts.channel.id, channelTitle: opts.channel.title } : {}),
});

export type PendingLogin = {
  authorizeUrl: string;
  redirectUri: string;
  /** Settles when the browser half completes and the tokens are on disk. */
  done: Promise<StoredTokens>;
  cancel: () => void;
};

/**
 * Start a login: PKCE, a loopback listener, the authorize URL. The exchange,
 * identity lookup and persist happen when the callback arrives, so a caller
 * that cannot open a browser can hand the URL to a human and return at once.
 */
export const startLogin = async (opts: {
  config: Config;
  store: TokenStore;
  oauth: OAuthClient;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  timeoutMs?: number;
}): Promise<PendingLogin> => {
  const { config, store, oauth } = opts;
  const clientId = config.clientId as string;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const scopes = effectiveScopes(config);
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));
  const listener = await listenForCallback(state, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri: listener.redirectUri,
    scopes,
    state,
    challenge,
  });

  // Set by cancel(). Once the callback has arrived, closing the listener no
  // longer stops anything, so the exchange itself must check: a logout (or a
  // newer login) during the exchange would otherwise be overwritten by these
  // tokens a moment later — a live refresh token nobody asked for.
  let cancelled = false;
  const done = (async () => {
    const code = await listener.code;
    const res = await oauth.exchangeCode(code, verifier, listener.redirectUri);
    if (cancelled) {
      await oauth.revoke(res.refresh_token ?? res.access_token);
      throw new Error("This login was cancelled before it finished; its token was revoked.");
    }
    if (!res.refresh_token) {
      throw new Error(
        "Google returned no refresh token, so the login would die within the hour. Revoke the app " +
          "at https://myaccount.google.com/permissions and call youtube_auth_login again.",
      );
    }
    let channel: { id: string; title: string } | null = null;
    try {
      channel = await fetchOwnChannel(fetchImpl, res.access_token, config.timeoutMs);
    } catch {
      // Identity is resolved again on the first call; the token works regardless.
    }
    const tokens = toStoredTokens(res, {
      clientId,
      requestedScopes: scopes,
      now: now(),
      refreshToken: res.refresh_token,
      channel,
    });
    if (cancelled) {
      await oauth.revoke(tokens.refreshToken);
      throw new Error("This login was cancelled before it finished; its token was revoked.");
    }
    store.write(tokens);
    opts.logger?.warn?.(
      `signed in${channel ? ` as channel "${channel.title}" (${channel.id})` : " (no channel found)"}`,
    );
    return tokens;
  })();
  // A login nobody awaits (open:false, then abandoned) must not surface as an
  // unhandled rejection that kills the process.
  done.catch(() => {});

  return {
    authorizeUrl,
    redirectUri: listener.redirectUri,
    done,
    cancel: () => {
      cancelled = true;
      listener.close();
    },
  };
};
