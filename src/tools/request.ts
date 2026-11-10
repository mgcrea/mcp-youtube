import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError, WritesDisabledError } from "#/client/errors";
import type { YoutubeClient } from "#/client/youtube";
import { API_BASE_URL } from "#/config";
import type { ToolContext } from "#/tools/index";
import { scoped } from "#/tools/util";

/**
 * A path under /youtube/v3: no scheme, no host, no traversal. Checked on the
 * URL as the parser resolves it, not on the string: `%2e%2e` is `..` to the
 * URL parser, and `/.%2e/.%2e/oauth2/v3/userinfo` would otherwise carry the
 * bearer token to another googleapis.com API.
 */
const assertSafePath = (path: string): void => {
  const resolved = new URL(`${API_BASE_URL}${path}`, API_BASE_URL);
  if (
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    resolved.origin !== new URL(API_BASE_URL).origin ||
    !resolved.pathname.startsWith("/youtube/v3/")
  ) {
    throw new PreconditionError(
      `"${path}" is not a YouTube Data API path. Pass a path such as "/captions" or "/comments", ` +
        "with query parameters in `query`, not in the path.",
    );
  }
};

export const registerRequestTool = (
  server: McpServer,
  client: YoutubeClient,
  ctx: ToolContext,
): void => {
  const methods = ctx.allowWrites
    ? (["GET", "POST", "PUT", "DELETE"] as const)
    : (["GET"] as const);

  server.registerTool(
    "youtube_request",
    {
      title: "YouTube: Request",
      description:
        "Escape hatch: call any YouTube Data API v3 endpoint (https://developers.google.com/youtube/v3/docs) " +
        "that has no dedicated tool, e.g. GET /captions, GET /commentThreads, GET /search. The path is " +
        "relative to /youtube/v3; parameters go in `query`. Returns the raw response, unshaped — " +
        "prefer the dedicated tools. Media uploads (captions, banners) are not possible through it. " +
        "Watch the cost: GET /search costs 100 units and has its own daily bucket. " +
        (ctx.allowWrites
          ? "Writes are ENABLED: POST/PUT/DELETE go straight to YouTube with no confirmation step — " +
            "check the path and body before calling."
          : "Writes are DISABLED: only GET is permitted. Set YOUTUBE_ALLOW_WRITES=1 to allow mutations."),
      inputSchema: z.object({
        method: z.enum(methods).default("GET").describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe('Path under /youtube/v3, e.g. "/captions" or "/commentThreads".'),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query parameters, e.g. {"part": "snippet", "videoId": "dQw4w9WgXcQ"}.'),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST/PUT."),
      }),
      annotations: {
        readOnlyHint: !ctx.allowWrites,
        destructiveHint: ctx.allowWrites,
        openWorldHint: true,
      },
    },
    async ({ method, path, query, body }) =>
      scoped(client, async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a request that skips schema validation.
        if (!ctx.allowWrites && method !== "GET")
          throw new WritesDisabledError(`youtube_request ${method}`);
        assertSafePath(path);
        const response = await client.request(method, path, {
          ...(query ? { query } : {}),
          ...(body ? { body } : {}),
        });
        return { response };
      }),
  );
};
