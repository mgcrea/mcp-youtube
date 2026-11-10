import { z } from "zod";

import { PreconditionError, WritesDisabledError, YoutubeApiError } from "#/client/errors";
import type { YoutubeClient } from "#/client/youtube";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed: `null, 2` adds 19-41% to every response, and
 * no model needs the indentation.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * `extra` is spread at the top level, so a `remedy` lands beside the error
 * rather than inside the upstream envelope, where it gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof YoutubeApiError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      status: err.status,
      ...(err.reason ? { reason: err.reason } : {}),
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof PreconditionError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
  }
  if (err instanceof WritesDisabledError) return fail(err.message);
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/**
 * Run a body that reads or writes channel data, stamping the channel beside
 * the result. The token decides which channel every call acts on, so this is
 * the only thing that makes "the wrong channel" visible from inside the
 * conversation — and, with YOUTUBE_CHANNEL_ID set, it refuses before the body
 * runs at all.
 */
export const scoped = <T extends Record<string, unknown>>(
  client: YoutubeClient,
  fn: () => Promise<T>,
): Promise<ToolResult> =>
  wrap(async () => {
    const channel = await client.assertChannel();
    return { channel: { id: channel.id, title: channel.title }, ...(await fn()) };
  });

/** Drop undefined values so we never send `{"pageToken": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

// ---- arg atoms -------------------------------------------------------------

export const videoIdArg = z
  .string()
  .regex(
    /^[\w-]{11}$/,
    "A video id is exactly 11 characters of letters, digits, - and _: the part after `v=` in a watch URL.",
  )
  .describe(
    'Video id: the 11 characters after `v=` in a watch URL, e.g. "dQw4w9WgXcQ". ' +
      "youtube_list_videos lists this channel's.",
  );

export const playlistIdArg = z
  .string()
  .regex(/^[\w-]{10,64}$/, "A playlist id is letters, digits, - and _, usually starting with PL.")
  .describe(
    'Playlist id, e.g. "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf" — the `list=` value of a playlist URL. ' +
      "youtube_list_playlists lists this channel's.",
  );

export const pageTokenArg = z
  .string()
  .optional()
  .describe("The `next_page_token` from the previous call, to fetch the next page.");

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(25)
  .describe("Maximum results per page (1-50, YouTube's own cap). Defaults to 25.");

/** Destructive tools require this, so an agent can never delete something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this permanently changes the channel.");

// YouTube rejects < and > in titles and descriptions (invalidTitle / invalidDescription).
const NO_ANGLE = /^[^<>]*$/;

export const titleArg = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(NO_ANGLE, "YouTube rejects < and > in titles.")
  .describe('Video title, 1-100 characters, no < or >. e.g. "Release 2.0 walkthrough".');

export const descriptionArg = z
  .string()
  .regex(NO_ANGLE, "YouTube rejects < and > in descriptions.")
  .refine(
    (s) => Buffer.byteLength(s, "utf8") <= 5000,
    "Descriptions are limited to 5000 bytes (UTF-8).",
  )
  .describe(
    "Video description, up to 5000 bytes, no < or >. Plain text; URLs become links, and lines like " +
      '"0:00 Intro" at the start of a line become chapters when there are at least three, the first at 0:00.',
  );

/** YouTube counts a tag with a space as if quoted, so "a b" costs 5, and the total cap is 500. */
export const tagsLength = (tags: string[]): number =>
  tags.reduce((sum, t) => sum + t.length + (t.includes(" ") ? 2 : 0), 0) +
  Math.max(0, tags.length - 1);

export const tagsArg = z
  .array(z.string().trim().min(1).regex(NO_ANGLE, "Tags cannot contain < or >."))
  .refine((tags) => tagsLength(tags) <= 500, "Tags total more than 500 characters (YouTube's cap).")
  .describe(
    'Keywords, e.g. ["typescript", "tutorial"]. Total at most 500 characters, counting a comma ' +
      "between tags and quotes around any tag containing a space. They barely affect discovery; " +
      "the title and description matter far more.",
  );

export const categoryIdArg = z
  .string()
  .regex(/^\d+$/, "A category id is digits only, from youtube_list_categories.")
  .describe(
    'Category id, digits, e.g. "28" (Science & Technology), "22" (People & Blogs), "27" (Education), ' +
      '"20" (Gaming). youtube_list_categories lists the assignable ones for a region.',
  );

export const privacyArg = z
  .enum(["private", "unlisted", "public"])
  .describe(
    "Who can see it: private (you only), unlisted (anyone with the link), public (everyone, and " +
      "subscribers may be notified).",
  );

export const publishAtArg = z
  .string()
  .datetime({ offset: true, message: 'An ISO 8601 time with a zone, e.g. "2026-12-01T17:00:00Z".' })
  .describe(
    'Schedule publication: an ISO 8601 time with a zone, e.g. "2026-12-01T17:00:00Z", in the ' +
      "future. The video must be private until then; YouTube makes it public at that time.",
  );

export const madeForKidsArg = z
  .boolean()
  .describe(
    "The audience declaration YouTube requires by law (COPPA): true only if the video is made for " +
      "children. Made-for-kids videos lose comments, notifications and personalized ads. Ask the " +
      "user if unsure — do not guess.",
  );

export const syntheticMediaArg = z
  .boolean()
  .describe(
    "Disclose realistic altered or synthetic content: true when the video makes a real person " +
      "appear to say or do something they did not, alters footage of a real event or place, or " +
      "shows a realistic-looking scene that did not happen. Not needed for obviously unrealistic " +
      "animation, colour correction, or AI used only for scripts or captions.",
  );

export const languageArg = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'A BCP-47 tag, e.g. "en", "fr", "pt-BR".')
  .describe('BCP-47 language of the title and description, e.g. "en" or "fr".');

export const filePathArg = (what: string, exts: string) =>
  z
    .string()
    .min(1)
    .describe(
      `Absolute path to the ${what} on the machine running this server, e.g. ` +
        `"/Users/me/Movies/demo.mp4". Accepted extensions: ${exts}. A relative path is refused: ` +
        "this server's working directory is not yours.",
    );
