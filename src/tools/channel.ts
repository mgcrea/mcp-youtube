import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { summarizeChannel, type Rec } from "#/client/shape";
import type { YoutubeClient } from "#/client/youtube";
import type { ToolContext } from "#/tools/index";
import { languageArg, scoped } from "#/tools/util";

export const registerChannelTools = (
  server: McpServer,
  client: YoutubeClient,
  _ctx: ToolContext,
): void => {
  server.registerTool(
    "youtube_get_channel",
    {
      title: "YouTube: Get Channel",
      description:
        "The channel the signed-in token acts as: id, handle, uploads playlist, subscriber/video/" +
        "view counts, and `long_uploads` — whether videos longer than 15 minutes are allowed. " +
        "Check that before uploading anything long: an unverified channel (`disallowed` or " +
        "`eligible`) cannot, and the failure only shows after the whole file has been sent. " +
        "Verify by phone at https://www.youtube.com/verify. Costs 1 quota unit.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      scoped(client, async () => {
        const res = await client.get<{ items?: Rec[] }>("/channels", {
          part: "snippet,contentDetails,statistics,status",
          mine: true,
        });
        return { details: summarizeChannel(res.items?.[0]) };
      }),
  );

  server.registerTool(
    "youtube_list_categories",
    {
      title: "YouTube: List Categories",
      description:
        "The video categories that can be assigned to an upload in a region, as {id, title}. Pass " +
        "the id as `categoryId` to youtube_upload_video or youtube_update_video. Categories vary " +
        "slightly by region, and some listed ones (e.g. Movies, Shows) are not assignable and are " +
        "filtered out here. Costs 1 quota unit.",
      inputSchema: z.object({
        region: z
          .string()
          .regex(/^[A-Z]{2}$/, "An ISO 3166-1 alpha-2 country code, upper-case, e.g. US or FR.")
          .default("US")
          .describe('ISO 3166-1 alpha-2 country, upper-case, e.g. "US", "FR". Defaults to US.'),
        language: languageArg
          .optional()
          .describe('Language for the titles, e.g. "fr". Defaults to English.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ region, language }) =>
      scoped(client, async () => {
        const res = await client.get<{ items?: Rec[] }>("/videoCategories", {
          part: "snippet",
          regionCode: region,
          ...(language ? { hl: language } : {}),
        });
        const categories = (res.items ?? [])
          .filter((c) => (c.snippet as Rec | undefined)?.assignable === true)
          .map((c) => ({ id: c.id, title: (c.snippet as Rec).title }));
        return { region, categories };
      }),
  );
};
