export class YoutubeApiError extends Error {
  // `string`, not the literal, so a subclass can override it.
  override readonly name: string = "YoutubeApiError";
  readonly status: number;
  /** Google's machine-readable reason, e.g. `quotaExceeded`, `videoNotFound`. */
  readonly reason: string | undefined;
  /**
   * What to do about it, kept separate from `message`: the message says what
   * happened, the remedy is the half a model should act on, and fail() lifts it
   * to a top-level field so it is not buried inside the upstream envelope.
   */
  readonly remedy: string | undefined;
  readonly errors: unknown;

  constructor(
    message: string,
    opts: { status: number; reason?: string; remedy?: string; errors?: unknown },
  ) {
    super(message);
    this.status = opts.status;
    this.reason = opts.reason;
    this.remedy = opts.remedy;
    this.errors = opts.errors;
  }
}

/** Thrown when a write path is reached while YOUTUBE_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set YOUTUBE_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}

/**
 * A local precondition failed before anything was sent: a bad path, a missing
 * login, the wrong channel. Carries a remedy like an API error does.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  readonly remedy: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, opts: { remedy?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.remedy = opts.remedy;
    this.details = opts.details;
  }
}

/** No usable token: never logged in, logged out, or the refresh token was revoked. */
export class SignInRequiredError extends PreconditionError {
  constructor(reason: string) {
    super(`Not signed in to YouTube: ${reason}.`, {
      remedy:
        "Call youtube_auth_login (it opens a browser for Google consent), then retry. " +
        "youtube_auth_status shows the current state.",
    });
  }
}

/**
 * Google's error envelope is `{error: {code, message, status, errors: [{reason,
 * domain, message}]}}`. The `reason` is the stable part; the message wording
 * drifts. Remedies are keyed on it.
 */
const REMEDIES: Record<string, string> = {
  quotaExceeded:
    "The project's daily quota is spent. It resets at midnight Pacific time. Uploads have their own " +
    "bucket (100 videos.insert calls/day since 2026-06-01); everything else shares 10,000 units/day " +
    "(a list costs 1, an update/delete/thumbnail/playlist write costs 50). Request more through the " +
    "YouTube API quota extension form in the Cloud console.",
  dailyLimitExceeded: "The project's daily quota is spent. It resets at midnight Pacific time.",
  uploadLimitExceeded:
    "This channel has hit YouTube's own per-channel upload limit (separate from API quota). It lifts " +
    "after roughly 24 hours; verifying the channel at https://www.youtube.com/verify raises it.",
  rateLimitExceeded: "Too many requests in a short window. Wait a few seconds and retry.",
  userRateLimitExceeded: "Too many requests in a short window. Wait a few seconds and retry.",
  accessNotConfigured:
    "The YouTube Data API v3 is not enabled in the Google Cloud project that owns this OAuth client. " +
    "Enable it at https://console.cloud.google.com/apis/library/youtube.googleapis.com.",
  SERVICE_DISABLED:
    "The YouTube Data API v3 is not enabled in the Google Cloud project that owns this OAuth client. " +
    "Enable it at https://console.cloud.google.com/apis/library/youtube.googleapis.com.",
  insufficientPermissions:
    "The token lacks the scope this call needs. If you just turned on YOUTUBE_ALLOW_WRITES, call " +
    "youtube_auth_login again to grant the `youtube` scope.",
  ACCESS_TOKEN_SCOPE_INSUFFICIENT:
    "The token lacks the scope this call needs. If you just turned on YOUTUBE_ALLOW_WRITES, call " +
    "youtube_auth_login again to grant the `youtube` scope.",
  youtubeSignupRequired:
    "The Google account that signed in has no YouTube channel. Create one at " +
    "https://www.youtube.com/create_channel, or sign in again and pick the channel's account.",
  authorizationRequired: "Call youtube_auth_login, then retry.",
  videoNotFound:
    "No video with that id on this channel. Ids are the 11 characters after `v=` in a watch URL; " +
    "youtube_list_videos lists this channel's.",
  playlistNotFound: "No such playlist. youtube_list_playlists lists this channel's.",
  invalidCategoryId:
    "That category cannot be assigned. youtube_list_categories lists the assignable ones.",
  invalidPublishAt:
    "publishAt must be a future ISO 8601 time and the video must be private; YouTube flips it " +
    "public at that time.",
  invalidTitle: "Titles must be 1-100 characters and cannot contain < or >.",
  invalidDescription: "Descriptions must be at most 5000 bytes and cannot contain < or >.",
  invalidTags:
    "Tags must total at most 500 characters (a tag containing a space counts its quotes).",
  forbiddenPrivacySetting:
    "That privacy setting is not allowed for this video (a video made for kids, or one still " +
    "processing, can refuse some changes).",
  defaultLanguageNotSet: "Set defaultLanguage when supplying localized metadata.",
  mediaBodyRequired: "The upload carried no video bytes.",
  invalidFilename: "The file name was rejected. Rename the file to plain ASCII and retry.",
};

export const remedyForReason = (reason: string | undefined): string | undefined =>
  reason === undefined ? undefined : REMEDIES[reason];

type GoogleErrorItem = { reason?: unknown; message?: unknown; domain?: unknown };
type GoogleErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    errors?: GoogleErrorItem[];
    details?: { reason?: unknown }[];
  };
};

/** Pull `{message, reason}` out of Google's envelope, tolerating anything else. */
export const parseGoogleError = (
  body: unknown,
): { message: string | undefined; reason: string | undefined; errors: unknown } => {
  if (typeof body !== "object" || body === null) {
    return { message: undefined, reason: undefined, errors: body };
  }
  const err = (body as GoogleErrorEnvelope).error;
  if (typeof err !== "object" || err === null) {
    return { message: undefined, reason: undefined, errors: body };
  }
  const first = Array.isArray(err.errors) ? err.errors[0] : undefined;
  const detailReason = Array.isArray(err.details)
    ? err.details.find((d) => typeof d?.reason === "string")?.reason
    : undefined;
  const reason =
    (typeof first?.reason === "string" ? first.reason : undefined) ??
    (typeof detailReason === "string" ? detailReason : undefined);
  return {
    message: typeof err.message === "string" ? err.message : undefined,
    reason,
    // The item list is the useful part; the rest restates the HTTP status.
    errors: Array.isArray(err.errors) ? err.errors : err,
  };
};
