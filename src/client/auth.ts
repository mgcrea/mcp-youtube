import { SignInRequiredError } from "#/client/errors";
import { OAuthError, toStoredTokens, type OAuthClient } from "#/client/oauth";
import type { StoredTokens, TokenStore } from "#/client/tokens";
import { scopesSatisfy } from "#/config";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type AuthStatus =
  | { signedIn: false; reason: string }
  | {
      signedIn: true;
      scopes: string[];
      channelId?: string;
      channelTitle?: string;
      obtainedAt: number;
    };

export type TokenProvider = {
  getToken(): Promise<string>;
  /** Called by the client's retry loop on a 401, so an expired token is reminted once. */
  invalidate(): void;
  /**
   * Whether invalidate() can produce a different token. A static key cannot,
   * so for it a 401 is final: retrying would only resend the rejected key.
   */
  readonly refreshable: boolean;
  describe(): AuthStatus;
};

/** A fixed token (tests): never refreshed, so a 401 is final. */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => {},
  refreshable: false,
  describe: () => ({ signedIn: true, scopes: [], obtainedAt: 0 }),
});

/** Why stored tokens cannot serve this install, or undefined when they can. */
export const staleness = (
  tokens: StoredTokens | undefined,
  clientId: string,
  requiredScopes: string[],
): string | undefined => {
  if (!tokens) return "no stored login";
  if (tokens.clientId !== clientId)
    return "the stored login belongs to a different YOUTUBE_CLIENT_ID";
  const missing = scopesSatisfy(tokens.scopes, requiredScopes);
  if (missing.length > 0) {
    // Say so now rather than letting Google answer 403 insufficientPermissions
    // for a reason the user cannot see from the error.
    return `the stored login lacks the scope(s) ${missing.join(", ")} — writes were probably enabled after logging in`;
  }
  return undefined;
};

/**
 * An OAuth2 user token, refreshed on demand. One in-flight promise coordinates
 * concurrent callers, so a burst of tool calls at expiry refreshes once.
 */
export const oauthTokenProvider = (opts: {
  store: TokenStore;
  oauth: OAuthClient;
  clientId: string;
  requiredScopes: string[];
  logger?: Logger | undefined;
  now?: () => number;
}): TokenProvider => {
  const now = opts.now ?? Date.now;
  /** Refresh a minute early, so a token cannot expire mid-flight. */
  const SKEW_MS = 60_000;
  let inFlight: Promise<string> | undefined;

  const refresh = async (tokens: StoredTokens): Promise<string> => {
    try {
      const res = await opts.oauth.refresh(tokens.refreshToken);
      const next = toStoredTokens(res, {
        clientId: opts.clientId,
        requestedScopes: tokens.scopes,
        now: now(),
        refreshToken: tokens.refreshToken,
        ...(tokens.channelId
          ? { channel: { id: tokens.channelId, title: tokens.channelTitle ?? "" } }
          : {}),
      });
      opts.store.write(next);
      return next.accessToken as string;
    } catch (err) {
      if (err instanceof OAuthError && err.code === "invalid_grant") {
        // The refresh token is dead for good: revoked, password changed, or —
        // by far the most common — the consent screen is still in Testing,
        // where Google expires refresh tokens after 7 days.
        throw new SignInRequiredError(
          "Google says the stored refresh token is expired or revoked (invalid_grant). If the " +
            "app's consent screen is still in Testing, Google expires refresh tokens after 7 days: " +
            "publish it (Google Auth Platform → Audience → Publish app) before logging in again",
        );
      }
      throw err;
    }
  };

  const resolve = async (): Promise<string> => {
    const tokens = opts.store.read();
    const reason = staleness(tokens, opts.clientId, opts.requiredScopes);
    if (reason) throw new SignInRequiredError(reason);
    const current = tokens as StoredTokens;
    if (current.accessToken && current.expiresAt - SKEW_MS > now()) return current.accessToken;
    return refresh(current);
  };

  return {
    getToken: async () => {
      inFlight ??= resolve().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    invalidate: () => {
      const tokens = opts.store.read();
      if (tokens) opts.store.write({ ...tokens, expiresAt: 0 });
      inFlight = undefined;
    },
    refreshable: true,
    describe: () => {
      const tokens = opts.store.read();
      const reason = staleness(tokens, opts.clientId, opts.requiredScopes);
      if (reason) return { signedIn: false, reason };
      const current = tokens as StoredTokens;
      return {
        signedIn: true,
        scopes: current.scopes,
        ...(current.channelId ? { channelId: current.channelId } : {}),
        ...(current.channelTitle ? { channelTitle: current.channelTitle } : {}),
        obtainedAt: current.obtainedAt,
      };
    },
  };
};
