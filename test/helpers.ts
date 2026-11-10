import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { staticTokenProvider, type TokenProvider } from "#/client/auth";
import { createMemoryTokenStore, TOKEN_FILE_VERSION } from "#/client/tokens";
import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * A config path that cannot exist, so the developer's own
 * ~/.config/youtube/config.json never leaks into the suite.
 */
export const ABSENT_CONFIG = "/nonexistent/youtube/config.json";

export const CLIENT_ENV = {
  YOUTUBE_CLIENT_ID: "test.apps.googleusercontent.com",
  YOUTUBE_CLIENT_SECRET: "test-secret",
};
export const WRITE_ENV = { ...CLIENT_ENV, YOUTUBE_ALLOW_WRITES: "1" };

export const CHANNEL = { id: "UCabcdefghijklmnopqrstuv", title: "Test Channel" };

export const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

export type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };

/** A route: return a Response to answer, or undefined to fall through. */
export type Route = (call: Call) => Response | Promise<Response | undefined> | undefined;

/** Answers `channels?mine=true` with CHANNEL, which every scoped tool asks first. */
export const channelRoute: Route = (call) =>
  call.url.pathname.endsWith("/channels") && call.url.searchParams.get("mine") === "true"
    ? jsonResponse({
        items: [
          {
            id: CHANNEL.id,
            snippet: { title: CHANNEL.title, customUrl: "@test" },
            contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
            statistics: { subscriberCount: "12", videoCount: "3", viewCount: "456" },
            status: { privacyStatus: "public", longUploadsStatus: "allowed" },
          },
        ],
      })
    : undefined;

/**
 * A fetch that records every call and answers from the routes in order. An
 * unmatched request fails loudly, so a test never passes by accident on a
 * request it did not expect.
 */
export const routedFetch = (routes: Route[]) => {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown = init.body;
    if (typeof body === "string" && headers["content-type"]?.includes("json"))
      body = JSON.parse(body);
    const call: Call = { method: init.method ?? "GET", url, headers, body };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res) return res;
    }
    throw new Error(`unexpected request: ${call.method} ${url.toString()}`);
  };
  return { fetch: impl as typeof fetch, calls };
};

export const signedInStore = () =>
  createMemoryTokenStore({
    version: TOKEN_FILE_VERSION,
    clientId: CLIENT_ENV.YOUTUBE_CLIENT_ID,
    scopes: ["https://www.googleapis.com/auth/youtube"],
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: Date.now(),
    channelId: CHANNEL.id,
    channelTitle: CHANNEL.title,
  });

/** A real container signature for each extension, so the content sniffing passes. */
const MAGIC: Record<string, number[]> = {
  mp4: [0, 0, 0, 0x20, ...Buffer.from("ftypisom")],
  mov: [0, 0, 0, 0x14, ...Buffer.from("ftypqt  ")],
  jpg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, ...Buffer.from("PNG")],
};

/**
 * A temp file of `bytes` bytes. A number fills the file with a real signature
 * for its extension followed by filler; a Uint8Array is written as given.
 */
export const tempFile = (name: string, bytes: number | Uint8Array): string => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-youtube-test-"));
  const path = join(dir, name);
  if (typeof bytes === "number") {
    const data = new Uint8Array(bytes).fill(7);
    data.set((MAGIC[name.split(".").pop() ?? ""] ?? []).slice(0, bytes));
    writeFileSync(path, data);
  } else {
    writeFileSync(path, bytes);
  }
  return path;
};

export const connect = async (
  env: Record<string, string> = CLIENT_ENV,
  opts: { routes?: Route[]; tokenProvider?: TokenProvider } = {},
) => {
  const config: Config = loadConfig({ ...env, HOME: "/nonexistent" }, ABSENT_CONFIG);
  const { fetch, calls } = routedFetch([...(opts.routes ?? []), channelRoute]);
  const { server, uploads } = createServer({
    config,
    fetch,
    tokenProvider: opts.tokenProvider ?? staticTokenProvider("test-token"),
    tokenStore: signedInStore(),
    openBrowser: async () => ({ opened: false, reason: "test" }),
    uploadBackoff: () => 1,
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    calls,
    uploads,
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body, so the harness reports it as an error.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
  };
};
