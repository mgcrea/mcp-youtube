import { McpServer } from "@modelcontextprotocol/server";

import { createAuthController, type AuthController } from "#/auth/controller";
import { openInBrowser, type OpenResult } from "#/auth/open";
import { BUILD_INFO } from "#/build-info";
import { oauthTokenProvider, type Logger, type TokenProvider } from "#/client/auth";
import { SignInRequiredError } from "#/client/errors";
import { createOAuthClient, type OAuthClient } from "#/client/oauth";
import {
  createFileTokenStore,
  createMemoryTokenStore,
  TOKEN_FILE_VERSION,
  type TokenStore,
} from "#/client/tokens";
import { YoutubeClient } from "#/client/youtube";
import {
  API_BASE_URL,
  effectiveScopes,
  isConfigured,
  UPLOAD_BASE_URL,
  type Config,
} from "#/config";
import { registerTools } from "#/tools/index";
import { UploadEngine } from "#/upload/engine";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-youtube-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests). */
  tokenProvider?: TokenProvider;
  /** Override the token store (tests). */
  tokenStore?: TokenStore;
  /** Override how the consent URL is opened (tests). */
  openBrowser?: (url: string) => Promise<OpenResult>;
  /** Override the API hosts (tests against a local server). */
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  /** Override the upload engine's backoff (tests). */
  uploadBackoff?: (attempt: number) => number;
};

export type CreatedServer = {
  server: McpServer;
  client: YoutubeClient;
  auth: AuthController;
  uploads: UploadEngine;
};

/** When nothing is configured: every call says what to set up. */
const unconfiguredProvider: TokenProvider = {
  getToken: async () => {
    throw new SignInRequiredError("no OAuth client is configured (see youtube_auth_status)");
  },
  invalidate: () => {},
  refreshable: false,
  describe: () => ({ signedIn: false, reason: "no OAuth client is configured" }),
};

const makeStore = (config: Config, logger: Logger | undefined): TokenStore => {
  if (!config.refreshToken) return createFileTokenStore(config.tokenFile, logger);
  // YOUTUBE_REFRESH_TOKEN: memory only, so a read-only container works. Scopes
  // are unknown until the first refresh reports them; assume what this
  // install needs rather than refusing before Google has had a say.
  return createMemoryTokenStore({
    version: TOKEN_FILE_VERSION,
    clientId: config.clientId ?? "",
    scopes: effectiveScopes(config),
    refreshToken: config.refreshToken,
    expiresAt: 0,
    obtainedAt: Date.now(),
  });
};

/**
 * A pure factory: no process.env, no stdio. `cli.ts` owns process concerns;
 * this takes everything as arguments so tests can drive real tools through the
 * real SDK against a mocked fetch.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const fetchImpl = opts.fetch ?? fetch;

  const store = opts.tokenStore ?? makeStore(config, opts.logger);
  const oauth: OAuthClient | undefined = isConfigured(config)
    ? createOAuthClient(config, fetchImpl)
    : undefined;
  const tokenProvider =
    opts.tokenProvider ??
    (oauth
      ? oauthTokenProvider({
          store,
          oauth,
          clientId: config.clientId as string,
          requiredScopes: effectiveScopes(config),
          logger: opts.logger,
        })
      : unconfiguredProvider);

  const client = new YoutubeClient({
    apiBaseUrl: opts.apiBaseUrl ?? API_BASE_URL,
    uploadBaseUrl: opts.uploadBaseUrl ?? UPLOAD_BASE_URL,
    tokenProvider,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    userAgent: USER_AGENT,
    expectedChannelId: config.channelId,
    fetch: fetchImpl,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const auth = createAuthController({
    config,
    store,
    oauth,
    tokenProvider,
    client,
    openBrowser: opts.openBrowser ?? openInBrowser,
    fetch: fetchImpl,
    logger: opts.logger,
  });

  const uploads = new UploadEngine({
    client,
    chunkSizeBytes: config.chunkSizeMb * 1024 * 1024,
    maxRetries: config.maxRetries,
    logger: opts.logger,
    ...(opts.uploadBackoff ? { backoff: opts.uploadBackoff } : {}),
  });

  registerTools(server, client, {
    config,
    allowWrites: config.allowWrites,
    hasCredentials: isConfigured(config),
    auth,
    uploads,
  });

  return { server, client, auth, uploads };
};
