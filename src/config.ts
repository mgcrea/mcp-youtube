import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

export const API_BASE_URL = "https://www.googleapis.com/youtube/v3";
/** Media goes to a different host path than metadata: `/upload/youtube/v3/...`. */
export const UPLOAD_BASE_URL = "https://www.googleapis.com/upload/youtube/v3";

/**
 * `youtube.readonly` for a read-only install, `youtube` once writes are on.
 * `youtube` alone covers insert, update, delete, playlists and thumbnails, so
 * there is no reason to also ask for `youtube.upload`. Computed rather than
 * configured: a read-only install never asks the user to consent to writes.
 */
export const SCOPE_READONLY = "https://www.googleapis.com/auth/youtube.readonly";
export const SCOPE_MANAGE = "https://www.googleapis.com/auth/youtube";

/** 16 MiB. Chunks must be a multiple of 256 KiB except the last. */
export const DEFAULT_CHUNK_MB = 16;

const ConfigSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    /** A refresh token supplied from outside (Docker, CI) instead of the token file. */
    refreshToken: z.string().min(1).optional(),
    tokenFile: z.string().min(1),
    allowWrites: z.boolean().default(false),
    /** Expected channel (`UC...`). Every call refuses if the token belongs to another one. */
    channelId: z
      .string()
      .regex(/^UC[\w-]{22}$/, "A YouTube channel id starts with UC and is 24 characters long.")
      .optional(),
    chunkSizeMb: z.number().int().min(1).max(1024).default(DEFAULT_CHUNK_MB),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    timeoutMs: z.number().int().positive().default(30_000),
  })
  .strict()
  .superRefine((_cfg, _ctx) => {
    // Deliberately NOT an error when no credentials are set. An MCP server that
    // exits on startup shows up in the client as a bare "Connection closed",
    // with stderr swallowed — so the one message that would have explained the
    // problem never reaches anyone. Report it through youtube_auth_status instead.
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * `.strict()` on purpose — a typo'd `clientID` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect",
 * which is the worst way to learn your credentials came from somewhere else.
 */
const FileSchema = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    refreshToken: z.string().optional(),
    tokenFile: z.string().optional(),
    allowWrites: z.boolean().optional(),
    channelId: z.string().optional(),
    chunkSizeMb: z.number().optional(),
    maxRetries: z.number().optional(),
    timeoutMs: z.number().optional(),
  })
  .strict();

type FileConfig = z.infer<typeof FileSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

const configDir = (env: NodeJS.ProcessEnv): string => {
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "youtube");
};

export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.YOUTUBE_CONFIG);
  return explicit ? expandTilde(explicit) : join(configDir(env), "config.json");
};

export const warnIfGroupReadable = (
  path: string,
  logger?: { warn?(...args: unknown[]): void },
): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      logger?.warn?.(`${path} is readable by other users. Run: chmod 600 ${path}`);
    }
  } catch {
    /* a missing file is fine */
  }
};

const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  warnIfGroupReadable(path, {
    warn: (...a) => process.stderr.write(`[youtube-mcp] ${a.join(" ")}\n`),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The config file ${path} is not valid JSON.`);
  }
  const result = FileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`The config file ${path} is invalid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker and CI inject the environment and must keep working untouched, while
 * a one-off `YOUTUBE_ALLOW_WRITES=0` still has to override a file that says
 * `true`. Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const tokenFile =
    trimmed(env.YOUTUBE_TOKEN_FILE) ??
    trimmed(file.tokenFile) ??
    join(configDir(env), "tokens.json");
  return ConfigSchema.parse({
    clientId: trimmed(env.YOUTUBE_CLIENT_ID) ?? trimmed(file.clientId),
    clientSecret: trimmed(env.YOUTUBE_CLIENT_SECRET) ?? trimmed(file.clientSecret),
    refreshToken: trimmed(env.YOUTUBE_REFRESH_TOKEN) ?? trimmed(file.refreshToken),
    tokenFile: expandTilde(tokenFile),
    allowWrites: parseBool(env.YOUTUBE_ALLOW_WRITES) ?? file.allowWrites,
    channelId: trimmed(env.YOUTUBE_CHANNEL_ID) ?? trimmed(file.channelId),
    chunkSizeMb: parseIntOpt(env.YOUTUBE_CHUNK_SIZE_MB) ?? file.chunkSizeMb,
    maxRetries: parseIntOpt(env.YOUTUBE_MAX_RETRIES) ?? file.maxRetries,
    timeoutMs: parseIntOpt(env.YOUTUBE_TIMEOUT_MS) ?? file.timeoutMs,
  });
};

/** An OAuth client is the minimum: without it there is no way to get or refresh a token. */
export const isConfigured = (config: Config): boolean =>
  Boolean(config.clientId) && Boolean(config.clientSecret);

export const effectiveScopes = (config: Config): string[] =>
  config.allowWrites ? [SCOPE_MANAGE] : [SCOPE_READONLY];

/** `youtube` is a superset of `youtube.readonly`, so it satisfies a read-only install. */
export const scopesSatisfy = (granted: string[], required: string[]): string[] =>
  required.filter(
    (scope) =>
      !granted.includes(scope) && !(scope === SCOPE_READONLY && granted.includes(SCOPE_MANAGE)),
  );

/** Returned by youtube_auth_status and printed to stderr at startup. */
export const setupInstructions = (config: Config): string[] =>
  isConfigured(config)
    ? []
    : [
        "1. Create a Google Cloud project: https://console.cloud.google.com/projectcreate",
        "2. Enable the YouTube Data API v3 in it: https://console.cloud.google.com/apis/library/youtube.googleapis.com",
        "3. Configure the OAuth consent screen (Google Auth Platform → Branding, Audience = External). " +
          "Then Audience → Publish app: while the app is in Testing, Google expires refresh tokens after 7 days. " +
          "An unverified app in production is fine for your own account — you click past one warning at login.",
        "4. Create an OAuth client (Google Auth Platform → Clients → Create client), Application type = Desktop app. " +
          "No redirect URI is needed: Desktop clients accept any loopback port.",
        "5. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to its values, restart the server, then call youtube_auth_login.",
        "Uploading also needs YOUTUBE_ALLOW_WRITES=1 — without it the write tools are not registered at all.",
      ];
