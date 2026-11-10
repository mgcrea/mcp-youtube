import type { McpServer } from "@modelcontextprotocol/server";

import type { AuthController } from "#/auth/controller";
import type { YoutubeClient } from "#/client/youtube";
import type { Config } from "#/config";
import { registerAuthTools } from "#/tools/auth";
import { registerChannelTools } from "#/tools/channel";
import { registerPlaylistTools } from "#/tools/playlists";
import { registerRequestTool } from "#/tools/request";
import { registerUploadTools } from "#/tools/upload";
import { registerVideoTools } from "#/tools/videos";
import type { UploadEngine } from "#/upload/engine";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see YOUTUBE_ALLOW_WRITES. */
  allowWrites: boolean;
  /** An OAuth client is configured, so a login is possible (it may not have happened yet). */
  hasCredentials: boolean;
  auth: AuthController;
  uploads: UploadEngine;
};

/**
 * Register the tools.
 *
 * - The auth tools are always registered, so an unconfigured server explains
 *   itself instead of closing the connection.
 * - The read tools are registered as soon as an OAuth client is configured,
 *   even before anyone has logged in: youtube_auth_login can then complete in
 *   the same session without a restart, and until it does each read answers
 *   with "call youtube_auth_login" rather than not existing.
 * - The write tools — upload included — are registered only with
 *   YOUTUBE_ALLOW_WRITES on. Not refused: absent, so they cannot be called.
 */
export const registerTools = (server: McpServer, client: YoutubeClient, ctx: ToolContext): void => {
  registerAuthTools(server, client, ctx);
  if (!ctx.hasCredentials) return;

  registerChannelTools(server, client, ctx);
  registerVideoTools(server, client, ctx);
  registerPlaylistTools(server, client, ctx);
  registerUploadTools(server, client, ctx);
  registerRequestTool(server, client, ctx);
};
