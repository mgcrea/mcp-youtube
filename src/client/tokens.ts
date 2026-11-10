import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "#/client/auth";
import { warnIfGroupReadable } from "#/config";

/**
 * Bumped when the shape changes incompatibly. A file from a future or unknown
 * version is treated as absent rather than guessed at — logging in again is a
 * 20-second cost, while misreading a token file fails in confusing ways.
 */
export const TOKEN_FILE_VERSION = 1;

export type StoredTokens = {
  version: number;
  /** A changed client id invalidates the whole file: the tokens belong to that app. */
  clientId: string;
  scopes: string[];
  accessToken?: string;
  /**
   * Google does not rotate refresh tokens: a refresh answers with a new access
   * token only, and the refresh token stays valid until revoked, until the user
   * changes their password, or — for an app still in Testing — for 7 days.
   */
  refreshToken: string;
  /** Milliseconds since epoch. 0 means "refresh before use". */
  expiresAt: number;
  obtainedAt: number;
  /** Who consented, resolved at login. The token picks the channel, so this is the tenant. */
  channelId?: string;
  channelTitle?: string;
};

export type TokenStore = {
  read(): StoredTokens | undefined;
  write(tokens: StoredTokens): void;
  clear(): void;
  /** Undefined for an in-memory store (YOUTUBE_REFRESH_TOKEN). */
  path: string | undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The on-disk token file, served from memory and re-read when its mtime
 * changes. Two stdio instances (one per editor window) share the file, and a
 * memo that never looked again would keep acting as the old channel after the
 * other one logged in — then write that stale login back over the new one on
 * its next refresh. A stat per request is the price, and it is negligible.
 */
export const createFileTokenStore = (path: string, logger?: Logger): TokenStore => {
  let cached: StoredTokens | undefined;
  let loadedMtime: number | undefined;
  let loaded = false;

  const currentMtime = (): number | undefined => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  };

  const readDisk = (): StoredTokens | undefined => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read the token file (${path}): ${message(err)}`, { cause: err });
    }
    warnIfGroupReadable(path, logger);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger?.warn?.(`${path} is not valid JSON — call youtube_auth_login again.`);
      return undefined;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as StoredTokens).version !== TOKEN_FILE_VERSION ||
      typeof (parsed as StoredTokens).refreshToken !== "string"
    ) {
      return undefined;
    }
    return parsed as StoredTokens;
  };

  return {
    path,
    read() {
      const mtime = currentMtime();
      if (!loaded || mtime !== loadedMtime) {
        cached = mtime === undefined ? undefined : readDisk();
        loadedMtime = mtime;
        loaded = true;
      }
      return cached;
    },
    write(tokens) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Temp file + rename: atomic, so a concurrent reader never sees half a
      // file, and the mode is 0600 from the first byte.
      const tmp = join(dirname(path), `.tokens.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      cached = tokens;
      loadedMtime = currentMtime();
      loaded = true;
    },
    clear() {
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      cached = undefined;
      loadedMtime = undefined;
      loaded = true;
    },
  };
};

/**
 * For YOUTUBE_REFRESH_TOKEN: nothing touches disk, so a container with a
 * read-only filesystem works. The granted scopes are unknown until the first
 * refresh answers, so they start as the scopes this install would ask for.
 */
export const createMemoryTokenStore = (seed: StoredTokens | undefined): TokenStore => {
  let current = seed;
  return {
    path: undefined,
    read: () => current,
    write: (tokens) => {
      current = tokens;
    },
    clear: () => {
      current = undefined;
    },
  };
};

/** Mode bits of the token file, for youtube_auth_status. */
export const fileMode = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
};
