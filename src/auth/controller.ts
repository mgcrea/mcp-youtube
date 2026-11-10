import type { OpenResult } from "#/auth/open";
import type { Logger, TokenProvider } from "#/client/auth";
import { PreconditionError } from "#/client/errors";
import { startLogin, type OAuthClient, type PendingLogin } from "#/client/oauth";
import type { StoredTokens, TokenStore } from "#/client/tokens";
import type { YoutubeClient } from "#/client/youtube";
import type { Config } from "#/config";

export type LoginOutcome =
  | { signedIn: true; tokens: StoredTokens }
  | {
      signedIn: false;
      pending: true;
      authorizeUrl: string;
      browser: OpenResult;
    };

/**
 * Owns the login lifecycle, so the tools stay thin: at most one pending login
 * at a time, and every change of identity drops the client's cached channel.
 */
export type AuthController = {
  readonly tokenProvider: TokenProvider;
  readonly store: TokenStore;
  /** The authorize URL of a login still waiting for its browser half. */
  pendingUrl(): string | undefined;
  /** The error that ended the last login, if it failed. */
  lastError(): string | undefined;
  login(opts: { open: boolean; waitMs: number }): Promise<LoginOutcome>;
  logout(): Promise<{ hadLogin: boolean; revoked: boolean }>;
};

export const createAuthController = (opts: {
  config: Config;
  store: TokenStore;
  oauth: OAuthClient | undefined;
  tokenProvider: TokenProvider;
  client: YoutubeClient;
  openBrowser: (url: string) => Promise<OpenResult>;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
  loginTimeoutMs?: number;
}): AuthController => {
  let pending: PendingLogin | undefined;
  let lastError: string | undefined;

  return {
    tokenProvider: opts.tokenProvider,
    store: opts.store,
    pendingUrl: () => pending?.authorizeUrl,
    lastError: () => lastError,

    async login({ open, waitMs }) {
      if (!opts.oauth) {
        throw new PreconditionError(
          "No OAuth client is configured, so there is nothing to log in to.",
          {
            remedy:
              "Call youtube_auth_status for the setup steps (YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET).",
          },
        );
      }
      const superseded = pending;
      pending = undefined;
      superseded?.cancel();
      lastError = undefined;
      const login = await startLogin({
        config: opts.config,
        store: opts.store,
        oauth: opts.oauth,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
        ...(opts.loginTimeoutMs !== undefined ? { timeoutMs: opts.loginTimeoutMs } : {}),
      });
      pending = login;
      // Only the CURRENT login may report back: a superseded one rejects
      // with "cancelled", and that must not show up beside a fresh success.
      void login.done.then(
        () => {
          if (pending !== login) return;
          pending = undefined;
          lastError = undefined;
          opts.client.resetChannel();
        },
        (err: unknown) => {
          if (pending !== login) return;
          pending = undefined;
          lastError = err instanceof Error ? err.message : String(err);
        },
      );

      opts.logger?.warn?.(`Open this URL to sign in to YouTube:\n${login.authorizeUrl}`);
      const browser: OpenResult = open
        ? await opts.openBrowser(login.authorizeUrl)
        : { opened: false, reason: "open was false" };

      if (browser.opened && waitMs > 0) {
        const winner = await Promise.race([
          login.done.then((tokens) => ({ tokens })),
          new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), waitMs).unref?.();
          }),
        ]);
        if (winner) return { signedIn: true, tokens: winner.tokens };
      }
      return { signedIn: false, pending: true, authorizeUrl: login.authorizeUrl, browser };
    },

    async logout() {
      const cancelling = pending;
      pending = undefined;
      lastError = undefined;
      cancelling?.cancel();
      const tokens = opts.store.read();
      // Revoke at Google too, not just locally: a deleted file leaves a live
      // refresh token in any backup or copy of it.
      const revoked = tokens && opts.oauth ? await opts.oauth.revoke(tokens.refreshToken) : false;
      opts.store.clear();
      opts.client.resetChannel();
      return { hadLogin: tokens !== undefined, revoked };
    },
  };
};
