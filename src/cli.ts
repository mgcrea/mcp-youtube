#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { isConfigured, loadConfigSafely, setupInstructions } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.YOUTUBE_DEBUG) console.error("[youtube-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[youtube-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[youtube-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfigSafely();
  const { server, client, auth } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // describe() reads the token file, which throws on anything but "missing" (a
  // directory, no permission). At startup that would exit the server (rule 2),
  // so report it instead; youtube_auth_status shows the same error on demand.
  let status: ReturnType<typeof auth.tokenProvider.describe>;
  try {
    status = auth.tokenProvider.describe();
  } catch (err) {
    stderrLogger.warn(err instanceof Error ? err.message : String(err));
    status = { signedIn: false, reason: "the token file could not be read" };
  }
  stderrLogger.warn(
    `youtube-mcp connected (oauth-client=${isConfigured(config) ? "set" : "MISSING"}, ` +
      `signed-in=${status.signedIn ? "yes" : "no"}, ` +
      `token=${config.refreshToken ? "env" : config.tokenFile}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"}` +
      `${config.channelId ? `, expected-channel=${config.channelId}` : ""})`,
  );
  for (const issue of config.issues) stderrLogger.warn(`config: ${issue}`);
  if (config.lockedReason) stderrLogger.warn(`LOCKED: ${config.lockedReason}`);
  for (const line of setupInstructions(config)) stderrLogger.warn(line);

  // The token picks the channel, so say which one — after connect, and not
  // awaited: startup must never depend on the network.
  if (status.signedIn) {
    client
      .assertChannel()
      .then((c) => stderrLogger.warn(`acting as channel "${c.title}" (${c.id})`))
      .catch((err: unknown) =>
        stderrLogger.warn(
          `could not resolve the channel: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[youtube-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
