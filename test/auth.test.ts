import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { oauthTokenProvider, staleness } from "#/client/auth";
import { SignInRequiredError } from "#/client/errors";
import { buildAuthorizeUrl, createOAuthClient, OAuthError, startLogin } from "#/client/oauth";
import { createFileTokenStore, createMemoryTokenStore, TOKEN_FILE_VERSION } from "#/client/tokens";
import { loadConfig, SCOPE_MANAGE, SCOPE_READONLY } from "#/config";
import { ABSENT_CONFIG, CHANNEL, CLIENT_ENV, jsonResponse, routedFetch } from "#test/helpers";

const dir = () => mkdtempSync(join(tmpdir(), "mcp-youtube-config-"));

describe("config", () => {
  it("never throws on missing credentials", () => {
    expect(() => loadConfig({}, ABSENT_CONFIG)).not.toThrow();
  });

  it("merges environment over file per field", () => {
    const path = join(dir(), "config.json");
    writeFileSync(
      path,
      JSON.stringify({ clientId: "file-id", clientSecret: "file-secret", allowWrites: true }),
      { mode: 0o600 },
    );
    const config = loadConfig({ YOUTUBE_CLIENT_ID: "env-id", YOUTUBE_ALLOW_WRITES: "0" }, path);
    expect(config.clientId).toBe("env-id");
    expect(config.clientSecret).toBe("file-secret");
    expect(config.allowWrites).toBe(false);
  });

  it("rejects an unknown key in the file instead of ignoring it", () => {
    const path = join(dir(), "config.json");
    writeFileSync(path, JSON.stringify({ clientID: "typo" }), { mode: 0o600 });
    expect(() => loadConfig({}, path)).toThrow(/clientID/);
  });
});

describe("authorize URL", () => {
  it("asks for offline access with forced consent and PKCE S256", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://127.0.0.1:5555",
        scopes: [SCOPE_MANAGE],
        state: "s",
        challenge: "c",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    // Without both, a second login comes back with no refresh token.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(SCOPE_MANAGE);
  });

  it("asks a read-only install for the read-only scope only", async () => {
    const config = loadConfig(CLIENT_ENV, ABSENT_CONFIG);
    const store = createMemoryTokenStore(undefined);
    const { fetch } = routedFetch([]);
    const login = await startLogin({
      config,
      store,
      oauth: createOAuthClient(config, fetch),
      timeoutMs: 1000,
    });
    login.cancel();
    expect(new URL(login.authorizeUrl).searchParams.get("scope")).toBe(SCOPE_READONLY);
    expect(login.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(login.done).rejects.toThrow(/cancelled/);
  });
});

describe("the loopback login", () => {
  it("exchanges the code, resolves the channel and persists mode 600", async () => {
    const config = loadConfig(CLIENT_ENV, ABSENT_CONFIG);
    const path = join(mkdtempSync(join(tmpdir(), "mcp-youtube-tokens-")), "tokens.json");
    const store = createFileTokenStore(path);
    const { fetch, calls } = routedFetch([
      (c) =>
        c.url.toString() === "https://oauth2.googleapis.com/token"
          ? jsonResponse({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3599,
              scope: SCOPE_READONLY,
            })
          : undefined,
      (c) =>
        c.url.pathname.endsWith("/channels")
          ? jsonResponse({ items: [{ id: CHANNEL.id, snippet: { title: CHANNEL.title } }] })
          : undefined,
    ]);
    const login = await startLogin({
      config,
      store,
      oauth: createOAuthClient(config, fetch),
      fetch,
      timeoutMs: 5000,
    });
    const state = new URL(login.authorizeUrl).searchParams.get("state") ?? "";

    // A forged callback without this login's state must not cancel it.
    const forged = await globalThis.fetch(`${login.redirectUri}/?error=access_denied&state=nope`);
    expect(forged.status).toBe(400);

    const ok = await globalThis.fetch(`${login.redirectUri}/?code=the-code&state=${state}`);
    expect(ok.status).toBe(200);
    const tokens = await login.done;

    expect(tokens).toMatchObject({
      refreshToken: "rt",
      channelId: CHANNEL.id,
      scopes: [SCOPE_READONLY],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const exchange = calls.find((c) => c.url.hostname === "oauth2.googleapis.com");
    const form = new URLSearchParams(String(exchange?.body));
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toHaveLength(43);
    expect(form.get("redirect_uri")).toBe(login.redirectUri);
    expect(form.get("client_secret")).toBe("test-secret");
  });
});

const seed = (over: Record<string, unknown> = {}) =>
  createMemoryTokenStore({
    version: TOKEN_FILE_VERSION,
    clientId: CLIENT_ENV.YOUTUBE_CLIENT_ID,
    scopes: [SCOPE_READONLY],
    refreshToken: "rt",
    expiresAt: 0,
    obtainedAt: 0,
    ...over,
  });

describe("the token provider", () => {
  it("turns invalid_grant into a sign-in request that names the 7-day Testing expiry", async () => {
    const provider = oauthTokenProvider({
      store: seed(),
      oauth: {
        exchangeCode: async () => ({ access_token: "" }),
        refresh: async () => {
          throw new OAuthError("HTTP 400 — invalid_grant", "invalid_grant");
        },
        revoke: async () => true,
      },
      clientId: CLIENT_ENV.YOUTUBE_CLIENT_ID,
      requiredScopes: [SCOPE_READONLY],
    });
    const err = await provider.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignInRequiredError);
    expect(String((err as Error).message)).toContain("7 days");
  });

  it("refreshes once for concurrent callers and keeps the refresh token", async () => {
    let refreshes = 0;
    const store = seed();
    const provider = oauthTokenProvider({
      store,
      oauth: {
        exchangeCode: async () => ({ access_token: "" }),
        refresh: async () => {
          refreshes += 1;
          return { access_token: "fresh", expires_in: 3600 };
        },
        revoke: async () => true,
      },
      clientId: CLIENT_ENV.YOUTUBE_CLIENT_ID,
      requiredScopes: [SCOPE_READONLY],
    });
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(tokens).toEqual(["fresh", "fresh", "fresh"]);
    expect(refreshes).toBe(1);
    // Google does not rotate refresh tokens; the original must survive.
    expect(store.read()?.refreshToken).toBe("rt");
  });

  it("treats a read-only login as stale once writes are enabled", () => {
    const tokens = seed().read();
    expect(staleness(tokens, CLIENT_ENV.YOUTUBE_CLIENT_ID, [SCOPE_MANAGE])).toContain("scope");
    // ...but a `youtube` login satisfies a read-only install.
    expect(
      staleness({ ...tokens!, scopes: [SCOPE_MANAGE] }, CLIENT_ENV.YOUTUBE_CLIENT_ID, [
        SCOPE_READONLY,
      ]),
    ).toBeUndefined();
  });
});

describe("login cancellation (2026-11-10 review)", () => {
  it("revokes instead of storing when the login is cancelled during the code exchange", async () => {
    const config = loadConfig(CLIENT_ENV, ABSENT_CONFIG);
    const store = createMemoryTokenStore(undefined);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const revoked: string[] = [];
    const { fetch } = routedFetch([
      async (c) => {
        if (c.url.toString() === "https://oauth2.googleapis.com/token") {
          await gate;
          return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3599 });
        }
        if (c.url.toString() === "https://oauth2.googleapis.com/revoke") {
          revoked.push(new URLSearchParams(String(c.body)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return undefined;
      },
    ]);
    const login = await startLogin({
      config,
      store,
      oauth: createOAuthClient(config, fetch),
      fetch,
      timeoutMs: 5000,
    });
    const state = new URL(login.authorizeUrl).searchParams.get("state") ?? "";
    await globalThis.fetch(`${login.redirectUri}/?code=c&state=${state}`);
    login.cancel(); // logout arrives while the exchange is in flight
    release();
    await expect(login.done).rejects.toThrow(/revoked/);
    expect(store.read()).toBeUndefined();
    expect(revoked).toEqual(["rt"]);
  });
});
