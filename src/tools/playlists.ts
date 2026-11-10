import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { summarizePlaylist, type Rec } from "#/client/shape";
import type { YoutubeClient } from "#/client/youtube";
import type { ToolContext } from "#/tools/index";
import {
  limitArg,
  pageTokenArg,
  playlistIdArg,
  privacyArg,
  scoped,
  videoIdArg,
} from "#/tools/util";
import { addToPlaylist } from "#/upload/engine";

export const registerPlaylistTools = (
  server: McpServer,
  client: YoutubeClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "youtube_list_playlists",
    {
      title: "YouTube: List Playlists",
      description:
        "This channel's playlists, including private ones: id, title, privacy and item count. The " +
        "id is what youtube_add_to_playlist and youtube_upload_video's playlistId take. Costs 1 " +
        "quota unit per page.",
      inputSchema: z.object({ limit: limitArg, page_token: pageTokenArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, page_token }) =>
      scoped(client, async () => {
        const res = await client.get<{ items?: Rec[]; nextPageToken?: string }>("/playlists", {
          part: "snippet,status,contentDetails",
          mine: true,
          maxResults: limit,
          ...(page_token ? { pageToken: page_token } : {}),
        });
        return {
          playlists: (res.items ?? []).map(summarizePlaylist),
          ...(res.nextPageToken ? { next_page_token: res.nextPageToken } : {}),
        };
      }),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "youtube_create_playlist",
    {
      title: "YouTube: Create Playlist",
      description:
        "Create a playlist on this channel. Not idempotent: two calls make two playlists with the " +
        "same title, so check youtube_list_playlists first. Defaults to private. Costs 50 quota units.",
      inputSchema: z.object({
        title: z
          .string()
          .trim()
          .min(1)
          .max(150)
          .describe('Playlist title, 1-150 characters, e.g. "Release walkthroughs".'),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe("Playlist description, up to 5000 characters."),
        privacy: privacyArg.default("private"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, description, privacy }) =>
      scoped(client, async () => {
        const created = await client.request<Rec>("POST", "/playlists", {
          query: { part: "snippet,status" },
          body: {
            snippet: { title, ...(description ? { description } : {}) },
            status: { privacyStatus: privacy },
          },
        });
        return { playlist: summarizePlaylist(created) };
      }),
  );

  server.registerTool(
    "youtube_add_to_playlist",
    {
      title: "YouTube: Add to Playlist",
      description:
        "Add a video to one of this channel's playlists, at the end or at a position. Not " +
        "idempotent: adding the same video twice lists it twice. youtube_upload_video can do this " +
        "as part of the upload via playlistId. Costs 50 quota units.",
      inputSchema: z.object({
        playlist_id: playlistIdArg,
        video_id: videoIdArg,
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based position in the playlist. Omit to append at the end."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ playlist_id, video_id, position }) =>
      scoped(client, async () => {
        const item = await addToPlaylist(client, playlist_id, video_id, position);
        return {
          playlist_item_id: item.id,
          playlist_id,
          video_id,
          position: (item.snippet as Rec | undefined)?.position,
        };
      }),
  );
};
