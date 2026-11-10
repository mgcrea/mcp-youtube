import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "#/client/errors";
import type { YoutubeClient } from "#/client/youtube";
import type { ToolContext } from "#/tools/index";
import {
  categoryIdArg,
  descriptionArg,
  filePathArg,
  languageArg,
  madeForKidsArg,
  playlistIdArg,
  privacyArg,
  publishAtArg,
  syntheticMediaArg,
  tagsArg,
  titleArg,
  wrap,
} from "#/tools/util";
import { describeJob, uploadKey, type UploadJob, type VideoStatus } from "#/upload/engine";
import { resolveImageFile, resolveVideoFile, VIDEO_MIME_TYPES } from "#/upload/files";

/** The MCP request handle a tool handler is given, narrowed to what progress needs. */
type ProgressRequest = {
  mcpReq: {
    _meta?: { progressToken?: string | number };
    notify: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
  };
};

const PROGRESS_INTERVAL_MS = 2000;

/**
 * Wait for a job to finish or the deadline to pass, emitting progress frames
 * when the caller sent a progress token. Silent otherwise: progress is opt-in
 * per call, and unrequested frames are dropped at the far end anyway.
 */
const waitForJob = async (job: UploadJob, waitMs: number, req: ProgressRequest): Promise<void> => {
  // oxlint-disable-next-line no-underscore-dangle -- `_meta` is the MCP protocol's own name.
  const progressToken = req.mcpReq._meta?.progressToken;
  const deadline = Date.now() + waitMs;
  const finished = (): boolean =>
    job.state === "succeeded" || job.state === "failed" || job.state === "unknown";
  // The spec requires progress to only ever increase; a resume can move
  // bytesSent backwards, so report the high-water mark.
  let reported = 0;
  while (!finished() && Date.now() < deadline) {
    await Promise.race([
      job.done,
      new Promise((r) =>
        setTimeout(r, Math.min(PROGRESS_INTERVAL_MS, Math.max(0, deadline - Date.now()))),
      ),
    ]);
    if (progressToken !== undefined && !finished() && job.bytesSent > reported) {
      reported = job.bytesSent;
      await req.mcpReq
        .notify({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: reported,
            total: job.request.file.size,
            message: `${job.state}: ${Math.round((job.bytesSent / job.request.file.size) * 100)}%`,
          },
        })
        .catch(() => {});
    }
  }
};

const nextStep = (job: UploadJob): string => {
  switch (job.state) {
    case "uploading":
    case "finishing":
      return `Still uploading. Call youtube_get_upload with upload_id "${job.id}" to follow it; do NOT call youtube_upload_video again, which would upload a second copy.`;
    case "succeeded":
      return "Uploaded. YouTube now processes it (minutes for HD, longer for 4K): youtube_get_upload or youtube_get_video shows processingStatus.";
    case "failed":
      return "The upload failed before YouTube received the whole file, so no video was created. Fix the cause in `error`, then call youtube_upload_video again.";
    case "unknown":
      return "Every byte was sent but the confirmation was lost: the video may exist. Check YouTube Studio for it BEFORE uploading again; youtube_list_videos lags a minute or more behind an upload.";
  }
};

export const registerUploadTools = (
  server: McpServer,
  client: YoutubeClient,
  ctx: ToolContext,
): void => {
  // Uploading is the write this server exists for, and still a write: with
  // YOUTUBE_ALLOW_WRITES off, these two tools do not exist.
  if (!ctx.allowWrites) return;

  server.registerTool(
    "youtube_upload_video",
    {
      title: "YouTube: Upload Video",
      description:
        "Upload a local video file to the signed-in channel (youtube_auth_status says which). The " +
        "upload runs in the background with resumable, chunked transfer that survives dropped " +
        "connections; this call waits up to wait_seconds and returns either the finished video " +
        "(id, URL, Studio URL) or an upload_id to follow with youtube_get_upload. NOT idempotent: " +
        "every call creates a new video, so never retry it to check on an upload. Defaults to " +
        "PRIVATE — the API itself would default to public. Uses 1 of the project's 100 uploads per " +
        "day, plus 50 units each for thumbnailPath and playlistId. There is no Shorts flag: a " +
        "vertical or square video up to 3 minutes becomes a Short automatically. A channel without " +
        "phone verification cannot upload videos over 15 minutes (youtube_get_channel shows " +
        "`long_uploads`), and that failure only appears after processing. Calling it again for the " +
        "same file, title and channel returns the existing upload instead of starting another, " +
        "unless force is true.",
      inputSchema: z.object({
        file_path: filePathArg("video file", Object.keys(VIDEO_MIME_TYPES).join(", ")),
        title: titleArg,
        description: descriptionArg.optional(),
        tags: tagsArg.optional(),
        categoryId: categoryIdArg.default("22"),
        privacy: privacyArg
          .default("private")
          .describe(
            "private (default: only you), unlisted (anyone with the link) or public (everyone; " +
              "subscribers may be notified). Ask before choosing public.",
          ),
        publishAt: publishAtArg.optional(),
        madeForKids: madeForKidsArg,
        containsSyntheticMedia: syntheticMediaArg.optional(),
        defaultLanguage: languageArg.optional(),
        notifySubscribers: z
          .boolean()
          .default(true)
          .describe(
            "Notify subscribers when the video becomes public. Defaults to true; set false for " +
              "minor or batch uploads.",
          ),
        playlistId: playlistIdArg
          .optional()
          .describe(
            "Add the video to this playlist once uploaded (from youtube_list_playlists). A failure " +
              "here is a warning, not a failed upload.",
          ),
        thumbnailPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to a .jpg or .png custom thumbnail (up to 50 MB, 1280x720 recommended), " +
              "set once the upload completes. Needs a verified channel; a failure is a warning.",
          ),
        // 45, not longer: the MCP client SDK times a request out after 60s by
        // default, and an agent whose call timed out never sees the upload_id —
        // so it uploads again.
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(280)
          .default(45)
          .describe(
            "How long to wait for the upload before returning its upload_id. 0 returns at once. " +
              "Defaults to 45; raise it only if your client's tool timeout is longer.",
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Upload even if this server already uploaded (or is uploading) the same file with the " +
              "same title to this channel. Defaults to false, which returns that upload instead.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, req) =>
      wrap(async () => {
        const file = await resolveVideoFile(args.file_path);
        // Validated now, not after the upload: a bad path must not cost one of
        // the 100 daily uploads before failing as a warning.
        if (args.thumbnailPath) await resolveImageFile(args.thumbnailPath);
        if (args.publishAt !== undefined) {
          if (args.privacy !== "private") {
            throw new PreconditionError(
              "publishAt schedules a private video to become public; it cannot be combined with " +
                `privacy "${args.privacy}".`,
              { remedy: 'Pass privacy "private" (the default) together with publishAt.' },
            );
          }
          if (Date.parse(args.publishAt) <= Date.now()) {
            throw new PreconditionError(`publishAt ${args.publishAt} is in the past.`);
          }
        }
        // The token picks the channel; check it (and YOUTUBE_CHANNEL_ID) before
        // a single byte goes anywhere.
        const channel = await client.assertChannel();

        const status: VideoStatus = {
          privacyStatus: args.privacy,
          selfDeclaredMadeForKids: args.madeForKids,
          ...(args.publishAt ? { publishAt: args.publishAt } : {}),
          ...(args.containsSyntheticMedia !== undefined
            ? { containsSyntheticMedia: args.containsSyntheticMedia }
            : {}),
        };
        const request = {
          file,
          snippet: {
            title: args.title,
            categoryId: args.categoryId,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.tags ? { tags: args.tags } : {}),
            ...(args.defaultLanguage ? { defaultLanguage: args.defaultLanguage } : {}),
          },
          status,
          notifySubscribers: args.notifySubscribers,
          ...(args.playlistId ? { playlistId: args.playlistId } : {}),
          ...(args.thumbnailPath ? { thumbnailPath: args.thumbnailPath } : {}),
          channel: { id: channel.id, title: channel.title },
        };
        const existing = args.force ? undefined : ctx.uploads.findDuplicate(uploadKey(request));
        if (existing) {
          await waitForJob(existing, args.wait_seconds * 1000, req as unknown as ProgressRequest);
          return {
            ...describeJob(existing),
            duplicate_of_existing_upload: true,
            note:
              "This server already uploaded (or is uploading) this file with this title to this " +
              "channel, so nothing new was started. Pass force: true to upload a second copy.",
            next_step: nextStep(existing),
          };
        }
        const job = ctx.uploads.start(request);
        await waitForJob(job, args.wait_seconds * 1000, req as unknown as ProgressRequest);
        return { ...describeJob(job), next_step: nextStep(job) };
      }),
  );

  server.registerTool(
    "youtube_get_upload",
    {
      title: "YouTube: Get Upload",
      description:
        "Follow an upload started by youtube_upload_video: bytes sent, percent, rate and ETA while " +
        "it runs; then the video id, URL and — with check_processing — YouTube's processing state. " +
        "Without upload_id, lists every upload this server process has run, running ones included — " +
        "use that to recover an upload_id after a timed-out call. Uploads live in this " +
        "process only: after a server restart an unfinished one is gone and must be started again. " +
        "Free while uploading; check_processing costs 1 quota unit.",
      inputSchema: z.object({
        upload_id: z
          .string()
          .regex(
            /^up_[0-9a-f]{12}$/,
            'An upload id looks like "up_1a2b3c4d5e6f", from youtube_upload_video.',
          )
          .optional()
          .describe(
            'The upload_id from youtube_upload_video, e.g. "up_1a2b3c4d5e6f". Omit to list all.',
          ),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(280)
          .default(0)
          .describe(
            "Wait up to this long for a running upload to finish before answering. Defaults to 0.",
          ),
        check_processing: z
          .boolean()
          .default(true)
          .describe(
            "For a finished upload, also fetch YouTube's processing status (1 quota unit). Defaults to true.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ upload_id, wait_seconds, check_processing }, req) =>
      wrap(async () => {
        if (!upload_id) {
          return { uploads: ctx.uploads.list().map((j) => describeJob(j)) };
        }
        const job = ctx.uploads.get(upload_id);
        if (!job) {
          throw new PreconditionError(`No upload ${upload_id} in this server process.`, {
            remedy:
              "Uploads are held in memory, so a server restart forgets them. Call youtube_get_upload " +
              "without upload_id to list the known ones, or youtube_list_videos to see what reached the channel.",
          });
        }
        if (wait_seconds > 0)
          await waitForJob(job, wait_seconds * 1000, req as unknown as ProgressRequest);
        const described = describeJob(job);
        const videoId = job.video?.id as string | undefined;
        if (check_processing && job.state === "succeeded" && videoId) {
          try {
            const res = await client.get<{ items?: Record<string, unknown>[] }>("/videos", {
              part: "status,processingDetails",
              id: videoId,
            });
            const v = res.items?.[0];
            const processing = (v?.processingDetails ?? {}) as Record<string, unknown>;
            const status = (v?.status ?? {}) as Record<string, unknown>;
            described.processing = {
              status: processing.processingStatus,
              ...(processing.processingProgress ? { progress: processing.processingProgress } : {}),
              ...(processing.processingFailureReason
                ? { failure_reason: processing.processingFailureReason }
                : {}),
              upload_status: status.uploadStatus,
              ...(status.failureReason ? { upload_failure_reason: status.failureReason } : {}),
              ...(status.rejectionReason ? { rejection_reason: status.rejectionReason } : {}),
              privacy: status.privacyStatus,
            };
          } catch (err) {
            described.processing = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { ...described, next_step: nextStep(job) };
      }),
  );
};
