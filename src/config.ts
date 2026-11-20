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

/** Bounds for the tuning values. Out-of-range input is clamped, not fatal. */
const CHUNK_MB = { min: 1, max: 1024, def: DEFAULT_CHUNK_MB };
const RETRIES = { min: 0, max: 10, def: 3 };
// The range the schema always accepted (positive), capped at setTimeout's own maximum, so a
// config that loaded before loads identically.
const TIMEOUT = { min: 1, max: 2_147_483_647, def: 30_000 };

const CHANNEL_ID = /^UC[\w-]{22}$/;

const ConfigSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    /** A refresh token supplied from outside (Docker, CI) instead of the token file. */
    refreshToken: z.string().min(1).optional(),
    tokenFile: z.string().min(1),
    allowWrites: z.boolean().default(false),
    /**
     * Expected channel (`UC...`). Every call refuses if the token belongs to
     * another one. Not format-checked here: a malformed value is reported in
     * `issues` and kept, and since it can never match a real channel, every
     * call refuses until it is fixed — failing closed rather than dropping the
     * guard someone set on purpose.
     */
    channelId: z.string().min(1).optional(),
    chunkSizeMb: z.number().int().min(CHUNK_MB.min).max(CHUNK_MB.max).default(CHUNK_MB.def),
    maxRetries: z.number().int().min(RETRIES.min).max(RETRIES.max).default(RETRIES.def),
    timeoutMs: z.number().int().min(TIMEOUT.min).max(TIMEOUT.max).default(TIMEOUT.def),
    /**
     * What was wrong with the configuration and what was done about it: a
     * tuning value out of range (clamped), a malformed config file (ignored),
     * a malformed channel id (kept, so every call refuses). Reported by
     * youtube_auth_status and on stderr at startup, never thrown: a throw here
     * exits the server, which the client shows as a bare "Connection closed"
     * with this very message swallowed (rule 2).
     */
    issues: z.array(z.string()).default([]),
    /**
     * Set when the config file existed but was ignored and the environment
     * does not name the expected channel: the file may have held the
     * YOUTUBE_CHANNEL_ID guard or the token file path, so dropping it could
     * widen access (writes on from the environment, against another channel's
     * login). Every data and write tool refuses with this message until the
     * file is fixed; the auth tools still work, so the server still explains.
     */
    lockedReason: z.string().optional(),
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

/** An unrecognised value is off — the safe direction — and reported. */
const parseBool = (
  name: string,
  value: string | undefined,
  issues: string[],
): boolean | undefined => {
  const t = trimmed(value)?.toLowerCase();
  if (t === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (!["0", "false", "no", "off"].includes(t)) {
    issues.push(`${name}="${value}" is not a boolean (use 1 or 0); treated as off.`);
  }
  return false;
};

/**
 * A tuning integer from the environment (a string) or the file (a number).
 * Not a number: the default, reported. Out of range: clamped, reported.
 */
const tuning = (
  envName: string,
  fileKey: string,
  envValue: string | undefined,
  fileValue: number | undefined,
  bounds: { min: number; max: number; def: number },
  issues: string[],
): number => {
  const fromEnv = trimmed(envValue);
  const name = fromEnv !== undefined ? envName : `${fileKey} (config file)`;
  const raw = fromEnv ?? fileValue;
  if (raw === undefined) return bounds.def;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n)) {
    if (fromEnv !== undefined) {
      // As before: an unreadable environment value falls through to the file's, then the default.
      const fallback = tuning(envName, fileKey, undefined, fileValue, bounds, issues);
      issues.push(`${name}="${raw}" is not an integer; using ${fallback}.`);
      return fallback;
    }
    issues.push(`${name}="${raw}" is not an integer; using the default ${bounds.def}.`);
    return bounds.def;
  }
  const clamped = Math.min(Math.max(n, bounds.min), bounds.max);
  if (clamped !== n) {
    issues.push(`${name}=${n} is outside ${bounds.min}-${bounds.max}; using ${clamped}.`);
  }
  return clamped;
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
 *
 * Never throws. A malformed config file (bad JSON, an unknown key such as a
 * typo'd `clientID`, a wrong type) is ignored WHOLE — not field by field, so a
 * half-read file cannot quietly mix with the environment — and reported in
 * `issues`. Unlike a server with no tenant guard, ignoring it is NOT always the
 * safe direction here: the file may hold the YOUTUBE_CHANNEL_ID guard, so the
 * data and write tools are locked (`lockedReason`) unless the environment names
 * the channel itself. The auth tools keep working and say why.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const issues: string[] = [];
  let file: FileConfig = {};
  let fileIgnored = false;
  try {
    file = readConfigFile(configPath);
  } catch (err) {
    fileIgnored = true;
    issues.push(
      `${err instanceof Error ? err.message : String(err)} The whole file was ignored; fix it and restart.`,
    );
  }
  const tokenFile =
    trimmed(env.YOUTUBE_TOKEN_FILE) ??
    trimmed(file.tokenFile) ??
    join(configDir(env), "tokens.json");
  const channelId = trimmed(env.YOUTUBE_CHANNEL_ID) ?? trimmed(file.channelId);
  if (channelId !== undefined && !CHANNEL_ID.test(channelId)) {
    issues.push(
      `YOUTUBE_CHANNEL_ID="${channelId}" is not a channel id (UC followed by 22 characters). It is ` +
        "kept, and matches no channel, so every data tool refuses until it is fixed.",
    );
  }
  return ConfigSchema.parse({
    clientId: trimmed(env.YOUTUBE_CLIENT_ID) ?? trimmed(file.clientId),
    clientSecret: trimmed(env.YOUTUBE_CLIENT_SECRET) ?? trimmed(file.clientSecret),
    refreshToken: trimmed(env.YOUTUBE_REFRESH_TOKEN) ?? trimmed(file.refreshToken),
    tokenFile: expandTilde(tokenFile),
    allowWrites:
      parseBool("YOUTUBE_ALLOW_WRITES", env.YOUTUBE_ALLOW_WRITES, issues) ?? file.allowWrites,
    channelId,
    chunkSizeMb: tuning(
      "YOUTUBE_CHUNK_SIZE_MB",
      "chunkSizeMb",
      env.YOUTUBE_CHUNK_SIZE_MB,
      file.chunkSizeMb,
      CHUNK_MB,
      issues,
    ),
    maxRetries: tuning(
      "YOUTUBE_MAX_RETRIES",
      "maxRetries",
      env.YOUTUBE_MAX_RETRIES,
      file.maxRetries,
      RETRIES,
      issues,
    ),
    timeoutMs: tuning(
      "YOUTUBE_TIMEOUT_MS",
      "timeoutMs",
      env.YOUTUBE_TIMEOUT_MS,
      file.timeoutMs,
      TIMEOUT,
      issues,
    ),
    issues,
    ...(fileIgnored && channelId === undefined
      ? {
          lockedReason:
            `The config file ${configPath} could not be used (see config_issues in ` +
            "youtube_auth_status). It may hold the YOUTUBE_CHANNEL_ID guard or the token file, " +
            "so nothing is read or changed until it is fixed, or YOUTUBE_CHANNEL_ID is set in " +
            "the environment. Then restart the server.",
        }
      : {}),
  });
};

/**
 * The last line of defence for rule 2: loadConfig() is written not to throw,
 * but if it ever does (a bug, an unreadable HOME), start from the defaults —
 * no credentials, writes off — and carry the error as an issue, so the server
 * still connects and youtube_auth_status can say what went wrong.
 */
export const loadConfigSafely = (
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): Config => {
  try {
    return loadConfig(env, configPath ?? resolveConfigPath(env));
  } catch (err) {
    return ConfigSchema.parse({
      tokenFile: join(homedir(), ".config", "youtube", "tokens.json"),
      issues: [
        `The configuration could not be loaded (${err instanceof Error ? err.message : String(err)}); ` +
          "started with defaults: no credentials, writes off.",
      ],
    });
  }
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
