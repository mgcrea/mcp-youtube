import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fileMode } from "#/client/tokens";
import type { YoutubeClient } from "#/client/youtube";
import { effectiveScopes, setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

const QUOTA_NOTE =
  "Quota is per Google Cloud project, per day, reset at midnight Pacific. Uploads have their own " +
  "bucket: 100 videos.insert calls/day at 1 unit each. Everything else shares 10,000 units/day: " +
  "a list or get costs 1, an update, delete, thumbnail or playlist write costs 50.";

/**
 * The auth tools double as the "Authenticate button" for supervisors that have
 * one: Bastion calls status, login and logout with no arguments and reads a
 * top-level boolean `signedIn` from the status reply. Keep those shapes stable.
 * All three are registered unconditionally — a supervisor calls them by name,
 * and a missing tool answers with a protocol error about nothing useful.
 */
export const registerAuthTools = (
  server: McpServer,
  client: YoutubeClient,
  ctx: ToolContext,
): void => {
  const available = ["youtube_auth_status", "youtube_auth_login", "youtube_auth_logout"];

  server.registerTool(
    "youtube_auth_status",
    {
      title: "YouTube: Auth Status",
      description:
        "Whether the server is configured and signed in, which channel the token acts as (the " +
        "token picks the channel, so this is where uploads land), the granted scopes, whether " +
        "write tools are registered, and the daily quota model. When unconfigured, returns the " +
        "exact setup steps. Call this first when a tool you expected is missing. Costs 1 quota " +
        "unit the first time it resolves the channel, then nothing.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      wrap(async () => {
        if (!ctx.hasCredentials) {
          return {
            configured: false,
            signedIn: false,
            available_without_credentials: available,
            setup: setupInstructions(ctx.config),
          };
        }
        const status = ctx.auth.tokenProvider.describe();
        const tokenFile = ctx.auth.store.path;
        const mode = tokenFile ? fileMode(tokenFile) : undefined;
        let channel: Record<string, unknown> | undefined;
        if (status.signedIn) {
          try {
            const c = await client.assertChannel();
            channel = { id: c.id, title: c.title, ...(c.handle ? { handle: c.handle } : {}) };
          } catch (err) {
            channel = { error: err instanceof Error ? err.message : String(err) };
            const remedy = (err as { remedy?: unknown }).remedy;
            if (typeof remedy === "string") channel.remedy = remedy;
          }
        }
        const pendingUrl = ctx.auth.pendingUrl();
        const lastError = ctx.auth.lastError();
        return {
          configured: true,
          signedIn: status.signedIn,
          ...(status.signedIn
            ? {
                channel,
                scopes: status.scopes,
                signed_in_at: new Date(status.obtainedAt).toISOString(),
              }
            : { reason: status.reason }),
          ...(ctx.config.channelId ? { expected_channel_id: ctx.config.channelId } : {}),
          writes: ctx.allowWrites
            ? "ENABLED — youtube_upload_video and the other write tools are registered"
            : "disabled — set YOUTUBE_ALLOW_WRITES=1 to register youtube_upload_video and the other write tools",
          required_scopes: effectiveScopes(ctx.config),
          token_source: tokenFile
            ? {
                file: tokenFile,
                mode: mode === undefined ? "absent" : `0${mode.toString(8)}`,
                ...(mode !== undefined && (mode & 0o077) !== 0
                  ? { warning: `Readable by other users. Run: chmod 600 ${tokenFile}` }
                  : {}),
              }
            : "YOUTUBE_REFRESH_TOKEN (environment; a login here lasts until restart)",
          ...(pendingUrl
            ? {
                pending_login: {
                  authorize_url: pendingUrl,
                  note: "Waiting for the browser consent.",
                },
              }
            : {}),
          ...(lastError ? { last_login_error: lastError } : {}),
          ...(status.signedIn ? {} : { next_step: "Call youtube_auth_login." }),
          quota: QUOTA_NOTE,
        };
      }),
  );

  server.registerTool(
    "youtube_auth_login",
    {
      title: "YouTube: Login",
      description:
        "Sign in with Google: opens the consent screen in the browser and waits for it to finish, " +
        "then stores a refresh token (mode 600) and reports which channel it acts as. On the " +
        "account chooser, pick the channel uploads should go to — a Brand Account channel is " +
        "listed separately from the personal one. The app is unverified, so Google shows a " +
        "warning first: Advanced → Go to (app). If no browser can be opened, or the wait runs " +
        "out, returns the authorize URL instead and keeps listening for 5 minutes; call " +
        "youtube_auth_status afterwards. Logging in again replaces the stored login.",
      inputSchema: z.object({
        open: z
          .boolean()
          .default(true)
          .describe("Open the consent screen in the default browser. false only returns the URL."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(280)
          .default(120)
          .describe(
            "How long to wait for the consent to complete before returning the URL instead. " +
              "Defaults to 120.",
          ),
      }),
      // Not readOnly (it opens a browser and writes a token file), but not
      // gated behind writes: signing in changes nothing on YouTube, and gating
      // it would leave a read-only install unable to see its own channel.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ open, wait_seconds }) =>
      wrap(async () => {
        if (!ctx.hasCredentials) {
          return {
            signedIn: false,
            error: "No OAuth client is configured, so there is nothing to log in to.",
            setup: setupInstructions(ctx.config),
          };
        }
        const outcome = await ctx.auth.login({ open, waitMs: wait_seconds * 1000 });
        if (!outcome.signedIn) {
          return {
            signedIn: false,
            pending: true,
            authorize_url: outcome.authorizeUrl,
            browser_opened: outcome.browser.opened,
            ...(outcome.browser.reason ? { browser_note: outcome.browser.reason } : {}),
            next_step:
              "Open authorize_url in a browser on this machine (the callback goes to 127.0.0.1), " +
              "approve, then call youtube_auth_status. The login listens for 5 minutes.",
          };
        }
        const { tokens } = outcome;
        const mismatch =
          ctx.config.channelId && tokens.channelId && tokens.channelId !== ctx.config.channelId;
        return {
          signedIn: true,
          channel: tokens.channelId
            ? { id: tokens.channelId, title: tokens.channelTitle }
            : "none — this Google account has no YouTube channel",
          scopes: tokens.scopes,
          ...(mismatch
            ? {
                warning:
                  `This login acts as ${tokens.channelId}, but YOUTUBE_CHANNEL_ID expects ` +
                  `${ctx.config.channelId}: every data tool will refuse. Log in again and pick ` +
                  "the right channel.",
              }
            : {}),
          note: "No restart needed: the YouTube tools use this login from the next call.",
        };
      }),
  );

  server.registerTool(
    "youtube_auth_logout",
    {
      title: "YouTube: Logout",
      description:
        "Revoke the stored refresh token at Google and delete it locally. Recoverable by calling " +
        "youtube_auth_login again. Uploads already in progress fail at their next chunk.",
      // No `confirm`: a supervisor's Sign out calls this with no arguments, and
      // the action is recoverable in the time it takes to log in again.
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      wrap(async () => {
        const { hadLogin, revoked } = await ctx.auth.logout();
        return {
          signedIn: false,
          signedOut: hadLogin,
          revoked_at_google: revoked,
          ...(hadLogin && !revoked
            ? {
                note:
                  "Deleted locally, but Google did not confirm the revocation. Remove the app at " +
                  "https://myaccount.google.com/permissions to be sure.",
              }
            : {}),
        };
      }),
  );
};
