import type { Logger, TokenProvider } from "#/client/auth";
import {
  parseGoogleError,
  PreconditionError,
  remedyForReason,
  YoutubeApiError,
} from "#/client/errors";

export type Query = Record<string, string | number | boolean | undefined>;

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Fallback by status, used when Google's envelope carries no known reason. */
const remedyForStatus = (status: number): string | undefined => {
  if (status === 401) {
    return "The access token was rejected. Call youtube_auth_login to sign in again.";
  }
  if (status === 403) {
    return "Authenticated, but this channel or token may not do that. Check the `reason` in details.";
  }
  if (status === 429) return "Rate limited. Wait a few seconds and retry.";
  return undefined;
};

/** Turn a non-2xx response body into a YoutubeApiError with a remedy. */
export const apiError = (
  what: string,
  res: { status: number; statusText: string },
  body: unknown,
): YoutubeApiError => {
  const { message, reason, errors } = parseGoogleError(body);
  const remedy = remedyForReason(reason) ?? remedyForStatus(res.status);
  return new YoutubeApiError(
    `${what} failed: HTTP ${res.status}${reason ? ` ${reason}` : ""}${message ? ` — ${message}` : ""}`,
    { status: res.status, ...(reason ? { reason } : {}), ...(remedy ? { remedy } : {}), errors },
  );
};

export const parseBody = (text: string): unknown => {
  if (!text) return undefined;
  // A proxy's 502 page is HTML; parsing it must not hide the status.
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
};

/**
 * Retry only on what Google documents as transient. A 403 is usually final
 * (`quotaExceeded`, `forbidden`), but `rateLimitExceeded` and
 * `userRateLimitExceeded` arrive as 403 too and do clear on their own.
 */
export const isTransient = (status: number, body: unknown): boolean => {
  if (status === 429 || status >= 500) return true;
  if (status === 403) {
    const { reason } = parseGoogleError(body);
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
  }
  return false;
};

export type Channel = { id: string; title: string; handle: string | undefined };

export type YoutubeClientOptions = {
  apiBaseUrl: string;
  uploadBaseUrl: string;
  tokenProvider: TokenProvider;
  maxRetries: number;
  timeoutMs: number;
  userAgent: string;
  /** Refuse to act when the token resolves to a different channel. */
  expectedChannelId?: string | undefined;
  fetch?: typeof fetch;
  logger?: Logger;
};

export class YoutubeClient {
  readonly apiBaseUrl: string;
  readonly uploadBaseUrl: string;
  readonly tokens: TokenProvider;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly userAgent: string;
  readonly fetchImpl: typeof fetch;
  readonly logger: Logger | undefined;
  private readonly expectedChannelId: string | undefined;
  private channelPromise: Promise<Channel> | undefined;

  constructor(opts: YoutubeClientOptions) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.uploadBaseUrl = opts.uploadBaseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokenProvider;
    this.maxRetries = opts.maxRetries;
    this.timeoutMs = opts.timeoutMs;
    this.userAgent = opts.userAgent;
    this.expectedChannelId = opts.expectedChannelId;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch with the bearer token, refreshing and retrying once on a 401. The
   * upload engine uses this directly, because its responses (308 Resume
   * Incomplete, a Range header) are not JSON-API answers.
   */
  async authedFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.tokens.getToken();
      const res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      if (res.status === 401 && this.tokens.refreshable && attempt === 0) {
        this.logger?.warn?.("HTTP 401 — refreshing token and retrying");
        await res.body?.cancel();
        this.tokens.invalidate();
        continue;
      }
      return res;
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      query?: Query;
      body?: unknown;
      base?: "api" | "upload";
      raw?: { data: Uint8Array; contentType: string };
    } = {},
  ): Promise<T> {
    const base = opts.base === "upload" ? this.uploadBaseUrl : this.apiBaseUrl;
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt += 1) {
      this.logger?.debug?.(`${method} ${url.pathname} (attempt ${attempt + 1})`);
      const headers: Record<string, string> = { Accept: "application/json" };
      let body: NonNullable<RequestInit["body"]> | undefined;
      if (opts.raw) {
        headers["Content-Type"] = opts.raw.contentType;
        body = opts.raw.data as unknown as NonNullable<RequestInit["body"]>;
      } else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      const res = await this.authedFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(opts.raw ? Math.max(this.timeoutMs, 300_000) : this.timeoutMs),
      });
      const parsed = parseBody(await res.text());
      // A DELETE retried after a 5xx that had in fact gone through finds the
      // resource gone. That is the outcome the caller asked for, not a failure.
      if (method === "DELETE" && attempt > 0 && res.status === 404) return undefined as T;
      if (!res.ok && this.retryable(method, res.status, parsed) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`HTTP ${res.status} — retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (!res.ok) throw apiError(`${method} ${url.pathname}`, res, parsed);
      return parsed as T;
    }
  }

  /**
   * A 5xx can arrive after a write committed, so only methods that are safe to
   * repeat retry on it. A POST (create playlist, add playlist item, set
   * thumbnail) retries only on a rate limit, which YouTube answers before
   * doing anything — otherwise one flaky 500 makes two playlists.
   */
  private retryable(method: string, status: number, body: unknown): boolean {
    if (!isTransient(status, body)) return false;
    if (method !== "POST") return true;
    return status === 429 || status === 403;
  }

  /**
   * Which channel this token acts as. The consent screen is where a user with
   * Brand Accounts picks a channel, so the token — not any request parameter —
   * decides where an upload lands. Resolved once and cached; a failure is not
   * cached, or one transient error would stick for the life of the process.
   */
  channel(): Promise<Channel> {
    this.channelPromise ??= this.fetchChannel().catch((err: unknown) => {
      this.channelPromise = undefined;
      throw err;
    });
    return this.channelPromise;
  }

  /** Forget the cached identity, after a login or logout. */
  resetChannel(): void {
    this.channelPromise = undefined;
  }

  private async fetchChannel(): Promise<Channel> {
    const res = await this.get<{
      items?: { id: string; snippet?: { title?: string; customUrl?: string } }[];
    }>("/channels", { part: "snippet", mine: true });
    const item = res.items?.[0];
    if (!item) {
      throw new PreconditionError("The signed-in Google account has no YouTube channel.", {
        remedy:
          "Create one at https://www.youtube.com/create_channel, or call youtube_auth_login and pick " +
          "the account (or Brand Account) that owns the channel.",
      });
    }
    return { id: item.id, title: item.snippet?.title ?? "", handle: item.snippet?.customUrl };
  }

  /** The channel, after checking it against YOUTUBE_CHANNEL_ID when that is set. */
  async assertChannel(): Promise<Channel> {
    const channel = await this.channel();
    if (this.expectedChannelId && channel.id !== this.expectedChannelId) {
      throw new PreconditionError(
        `The signed-in token acts as channel "${channel.title}" (${channel.id}), but ` +
          `YOUTUBE_CHANNEL_ID expects ${this.expectedChannelId}. Nothing was read or changed.`,
        {
          remedy:
            "Call youtube_auth_login and pick the right channel on Google's account chooser, or " +
            "correct YOUTUBE_CHANNEL_ID.",
          details: { actual: channel, expected: this.expectedChannelId },
        },
      );
    }
    return channel;
  }
}
