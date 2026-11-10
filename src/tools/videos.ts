import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "#/client/errors";
import { fullVideo, summarizeVideo, type Rec } from "#/client/shape";
import type { YoutubeClient } from "#/client/youtube";
import type { ToolContext } from "#/tools/index";
import {
  categoryIdArg,
  confirmArg,
  descriptionArg,
  filePathArg,
  languageArg,
  limitArg,
  madeForKidsArg,
  pageTokenArg,
  privacyArg,
  publishAtArg,
  scoped,
  syntheticMediaArg,
  tagsArg,
  titleArg,
  videoIdArg,
} from "#/tools/util";
import { setThumbnail } from "#/upload/engine";

type ListResponse = { items?: Rec[]; nextPageToken?: string; pageInfo?: { totalResults?: number } };

const getVideo = async (client: YoutubeClient, id: string, parts: string): Promise<Rec> => {
  const res = await client.get<ListResponse>("/videos", { part: parts, id });
  const video = res.items?.[0];
  if (!video) {
    throw new PreconditionError(`No video ${id} is visible to this channel.`, {
      remedy:
        "Check the id (11 characters after `v=`). A private video is only visible to the channel " +
        "that owns it — youtube_auth_status shows which channel this token acts as.",
    });
  }
  return video;
};

/** The writable fields of `status`; the rest of what videos.list returns is read-only. */
// selfDeclaredMadeForKids is carried over too: a part sent without a field
// deletes it, and losing the audience declaration silently would be worse
// than restating it.
const WRITABLE_STATUS = [
  "selfDeclaredMadeForKids",
  "privacyStatus",
  "publishAt",
  "license",
  "embeddable",
  "publicStatsViewable",
  "containsSyntheticMedia",
];
const WRITABLE_SNIPPET = [
  "title",
  "description",
  "tags",
  "categoryId",
  "defaultLanguage",
  "defaultAudioLanguage",
];

const pick = (source: unknown, keys: string[]): Rec =>
  Object.fromEntries(
    keys.flatMap((k) => {
      const v = (source as Rec | undefined)?.[k];
      return v === undefined ? [] : [[k, v]];
    }),
  );

export const registerVideoTools = (
  server: McpServer,
  client: YoutubeClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "youtube_list_videos",
    {
      title: "YouTube: List Videos",
      description:
        "This channel's uploads, newest first, including private, unlisted and scheduled ones: id, " +
        "title, privacy, upload status, duration, views/likes/comments and URL. A video still " +
        "processing shows upload_status `uploaded`; one that failed shows failure_reason or " +
        "rejection_reason. A just-uploaded video can take a minute or more to appear here, because " +
        "the uploads playlist is eventually consistent — youtube_get_video finds it at once. Costs 2 quota units per page (+1 the first time, to find the uploads " +
        "playlist). For one video's full detail use youtube_get_video.",
      inputSchema: z.object({ limit: limitArg, page_token: pageTokenArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, page_token }) =>
      scoped(client, async () => {
        const channels = await client.get<ListResponse>("/channels", {
          part: "contentDetails",
          mine: true,
        });
        const uploads = (
          (channels.items?.[0]?.contentDetails as Rec | undefined)?.relatedPlaylists as
            | Rec
            | undefined
        )?.uploads as string | undefined;
        if (!uploads) return { videos: [], note: "This channel has no uploads playlist yet." };
        const page = await client.get<ListResponse>("/playlistItems", {
          part: "contentDetails",
          playlistId: uploads,
          maxResults: limit,
          ...(page_token ? { pageToken: page_token } : {}),
        });
        const ids = (page.items ?? [])
          .map((i) => (i.contentDetails as Rec | undefined)?.videoId)
          .filter((id): id is string => typeof id === "string");
        if (ids.length === 0) return { videos: [] };
        const videos = await client.get<ListResponse>("/videos", {
          part: "snippet,status,contentDetails,statistics",
          id: ids.join(","),
          maxResults: 50,
        });
        // videos.list does not promise the order of `id`; restore newest-first.
        const byId = new Map((videos.items ?? []).map((v) => [String(v.id), v]));
        return {
          videos: ids.flatMap((id) => (byId.has(id) ? [summarizeVideo(byId.get(id))] : [])),
          ...(page.pageInfo?.totalResults !== undefined
            ? { total: page.pageInfo.totalResults }
            : {}),
          ...(page.nextPageToken ? { next_page_token: page.nextPageToken } : {}),
        };
      }),
  );

  server.registerTool(
    "youtube_get_video",
    {
      title: "YouTube: Get Video",
      description:
        "One video in full: snippet, status (privacy, uploadStatus, failure/rejection reason, " +
        "publishAt, madeForKids), contentDetails, statistics, and — for your own videos — " +
        "processingDetails (processing progress after an upload) and fileDetails. Use it to follow " +
        "processing after youtube_upload_video finishes: processingStatus goes `processing` → " +
        "`succeeded`. Costs 1 quota unit.",
      inputSchema: z.object({ video_id: videoIdArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ video_id }) =>
      scoped(client, async () => ({
        video: fullVideo(
          await getVideo(
            client,
            video_id,
            "snippet,status,contentDetails,statistics,processingDetails,fileDetails,suggestions",
          ),
        ),
      })),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "youtube_update_video",
    {
      title: "YouTube: Update Video",
      description:
        "Change a video's title, description, tags, category, language, privacy, schedule or " +
        "disclosures. Only the fields you pass change: the server reads the video first and merges, " +
        "because videos.update REPLACES every part it is sent — a raw update with only a title " +
        "would erase the tags and description. Making a video public is immediate and visible to " +
        "everyone; subscribers are not re-notified. Costs 51 quota units (a read plus an update).",
      inputSchema: z.object({
        video_id: videoIdArg,
        title: titleArg.optional(),
        description: descriptionArg.optional(),
        tags: tagsArg.optional(),
        categoryId: categoryIdArg.optional(),
        defaultLanguage: languageArg.optional(),
        privacy: privacyArg.optional(),
        publishAt: publishAtArg
          .nullable()
          .optional()
          .describe(
            'Schedule publication, ISO 8601 with a zone, e.g. "2026-12-01T17:00:00Z". Requires the ' +
              "video to be (or be set) private. null cancels a schedule.",
          ),
        madeForKids: madeForKidsArg.optional(),
        containsSyntheticMedia: syntheticMediaArg.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      scoped(client, async () => {
        const {
          video_id,
          privacy,
          publishAt,
          madeForKids,
          containsSyntheticMedia,
          ...snippetArgs
        } = args;
        const snippetChanges = Object.entries(snippetArgs).filter(([, v]) => v !== undefined);
        const statusTouched =
          privacy !== undefined ||
          publishAt !== undefined ||
          madeForKids !== undefined ||
          containsSyntheticMedia !== undefined;
        if (snippetChanges.length === 0 && !statusTouched) {
          throw new PreconditionError(
            "Nothing to change: pass at least one field besides video_id.",
          );
        }
        const current = await getVideo(client, video_id, "snippet,status");

        const parts: string[] = [];
        const body: Rec = { id: video_id };
        if (snippetChanges.length > 0) {
          // categoryId is mandatory in an update's snippet, so the current one
          // is carried over along with everything else not being changed.
          parts.push("snippet");
          body.snippet = {
            ...pick(current.snippet, WRITABLE_SNIPPET),
            ...Object.fromEntries(snippetChanges),
          };
        }
        if (statusTouched) {
          const status = pick(current.status, WRITABLE_STATUS);
          if (privacy !== undefined) status.privacyStatus = privacy;
          if (publishAt === null) delete status.publishAt;
          else if (publishAt !== undefined) {
            if ((privacy ?? status.privacyStatus) !== "private") {
              throw new PreconditionError(
                "publishAt needs the video to stay private until then; YouTube makes it public at that time.",
                {
                  remedy:
                    'Pass privacy: "private" with publishAt, or omit privacy if it is already private.',
                },
              );
            }
            status.publishAt = publishAt;
          }
          // A scheduled time on a non-private video is rejected (invalidPublishAt).
          if (status.privacyStatus !== "private") delete status.publishAt;
          // Only sent when asked: YouTube changes it only when it is included (2026-10-15).
          if (madeForKids !== undefined) status.selfDeclaredMadeForKids = madeForKids;
          if (containsSyntheticMedia !== undefined)
            status.containsSyntheticMedia = containsSyntheticMedia;
          parts.push("status");
          body.status = status;
        }
        const updated = await client.request<Rec>("PUT", "/videos", {
          query: { part: parts.join(",") },
          body,
        });
        return { updated_parts: parts, video: summarizeVideo({ ...current, ...updated }) };
      }),
  );

  server.registerTool(
    "youtube_set_thumbnail",
    {
      title: "YouTube: Set Thumbnail",
      description:
        "Upload a custom thumbnail (JPEG or PNG, up to 50 MB; 1280x720 is the recommended size) " +
        "for one of your videos, replacing the current one. Needs a verified channel — an " +
        "unverified one gets 403 forbidden. Works on Shorts too, once processing has finished. " +
        "Costs 50 quota units.",
      inputSchema: z.object({
        video_id: videoIdArg,
        file_path: filePathArg("thumbnail image", ".jpg, .jpeg, .png"),
      }),
      // Replaces the current thumbnail, but not destructively: YouTube's
      // auto-generated stills stay selectable in Studio, so nothing is lost.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ video_id, file_path }) =>
      scoped(client, async () => {
        const res = await setThumbnail(client, video_id, file_path);
        const items = (res.items as Rec[] | undefined) ?? [];
        return { video_id, thumbnail_set: true, sizes: Object.keys((items[0] ?? {}) as Rec) };
      }),
  );

  server.registerTool(
    "youtube_delete_video",
    {
      title: "YouTube: Delete Video",
      description:
        "Permanently delete one of your videos, with its views, comments and likes. Irreversible: " +
        "YouTube keeps no undo, and re-uploading the same file gets a new id and starts from zero. " +
        "To hide a video instead, use youtube_update_video with privacy private. Costs 50 quota units.",
      inputSchema: z.object({ video_id: videoIdArg, confirm: confirmArg }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ video_id }) =>
      scoped(client, async () => {
        const video = await getVideo(client, video_id, "snippet");
        await client.request("DELETE", "/videos", { query: { id: video_id } });
        return { deleted: video_id, title: (video.snippet as Rec | undefined)?.title };
      }),
  );
};
