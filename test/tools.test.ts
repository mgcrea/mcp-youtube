import { describe, expect, it } from "vitest";

import { CHANNEL, CLIENT_ENV, connect, jsonResponse, WRITE_ENV, type Route } from "#test/helpers";

const AUTH_TOOLS = ["youtube_auth_login", "youtube_auth_logout", "youtube_auth_status"];
const READ_TOOLS = [
  "youtube_get_channel",
  "youtube_get_video",
  "youtube_list_categories",
  "youtube_list_playlists",
  "youtube_list_videos",
  "youtube_request",
];
const WRITE_TOOLS = [
  "youtube_add_to_playlist",
  "youtube_create_playlist",
  "youtube_delete_video",
  "youtube_get_upload",
  "youtube_set_thumbnail",
  "youtube_update_video",
  "youtube_upload_video",
];

describe("with no credentials configured", () => {
  // The regression that produces "MCP error -32000: Connection closed": a server
  // that exits on startup takes the credential-free tools with it and leaves no
  // way to discover what to configure.
  it("still connects, and serves only the auth tools", async () => {
    expect(await (await connect({})).toolNames()).toEqual(AUTH_TOOLS);
  });

  it("answers youtube_auth_status as a setup guide", async () => {
    const res = await (await connect({})).call("youtube_auth_status");
    expect(res.configured).toBe(false);
    expect(res.signedIn).toBe(false);
    expect((res.setup as string[]).join(" ")).toContain("YOUTUBE_CLIENT_ID");
    expect((res.setup as string[]).join(" ")).toContain("Desktop app");
  });

  it("answers youtube_auth_login with the setup steps rather than failing obscurely", async () => {
    const res = await (await connect({})).call("youtube_auth_login", { open: false });
    expect(res.signedIn).toBe(false);
    expect(res.setup).toBeDefined();
  });
});

describe("tool registration matrix", () => {
  it("registers the auth and read tools with an OAuth client and writes off", async () => {
    expect(await (await connect(CLIENT_ENV)).toolNames()).toEqual(
      [...AUTH_TOOLS, ...READ_TOOLS].toSorted(),
    );
  });

  it("adds exactly the write tools, upload included, with YOUTUBE_ALLOW_WRITES=1", async () => {
    expect(await (await connect(WRITE_ENV)).toolNames()).toEqual(
      [...AUTH_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS].toSorted(),
    );
  });

  it("treats YOUTUBE_ALLOW_WRITES=0 as off", async () => {
    const names = await (await connect({ ...CLIENT_ENV, YOUTUBE_ALLOW_WRITES: "0" })).toolNames();
    expect(names).not.toContain("youtube_upload_video");
  });

  it("narrows youtube_request to GET when writes are off", async () => {
    const tool = await (await connect(CLIENT_ENV)).tool("youtube_request");
    const method = ((tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>)
      .method;
    expect(method?.enum).toEqual(["GET"]);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});

/**
 * The contract every tool owes the model, enforced mechanically: a missing
 * `.describe()` is invisible in review and at runtime, and makes the model guess.
 */
describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    // `title` is what a host renders in its permission dialog.
    const tools = (await (await connect(WRITE_ENV)).client.listTools()).tools;
    expect(tools.length).toBe(AUTH_TOOLS.length + READ_TOOLS.length + WRITE_TOOLS.length);
    for (const tool of tools) expect(tool.title, tool.name).toMatch(/^YouTube: /);
  });

  it("describes every input field", async () => {
    for (const tool of (await (await connect(WRITE_ENV)).client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool, and marks delete destructive", async () => {
    const tools = (await (await connect(WRITE_ENV)).client.listTools()).tools;
    for (const tool of tools) expect(tool.annotations, tool.name).toBeDefined();
    const del = tools.find((t) => t.name === "youtube_delete_video");
    expect(del?.annotations?.destructiveHint).toBe(true);
    const upload = tools.find((t) => t.name === "youtube_upload_video");
    expect(upload?.annotations?.idempotentHint).toBe(false);
  });
});

describe("youtube_auth_status when signed in", () => {
  it("reports the channel the token acts as, which is where uploads land", async () => {
    const res = await (await connect(WRITE_ENV)).call("youtube_auth_status");
    expect(res.signedIn).toBe(true);
    expect(res.channel).toMatchObject({ id: CHANNEL.id, title: CHANNEL.title });
    expect(String(res.writes)).toMatch(/^ENABLED/);
  });
});

describe("the channel guard (rule 11)", () => {
  it("stamps the channel on every data response", async () => {
    const res = await (await connect(CLIENT_ENV)).call("youtube_get_channel");
    expect(res.channel).toEqual(CHANNEL);
    expect(res.details).toMatchObject({ long_uploads: "allowed", subscribers: 12 });
  });

  it("refuses to read anything when YOUTUBE_CHANNEL_ID names a different channel", async () => {
    const h = await connect({ ...CLIENT_ENV, YOUTUBE_CHANNEL_ID: "UCzzzzzzzzzzzzzzzzzzzzzz" });
    const res = await h.call("youtube_list_playlists");
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain(CHANNEL.id);
    expect(res.remedy).toContain("youtube_auth_login");
    // Only the identity lookup went out — never the playlist read.
    expect(h.calls.map((c) => c.url.pathname)).toEqual(["/youtube/v3/channels"]);
  });
});

describe("youtube_update_video", () => {
  const video = {
    id: "abcdefghijk",
    snippet: {
      title: "Old",
      description: "Keep me",
      tags: ["a", "b"],
      categoryId: "28",
      thumbnails: {},
      channelTitle: "x",
    },
    status: {
      privacyStatus: "private",
      uploadStatus: "processed",
      madeForKids: false,
      embeddable: true,
    },
  };
  const routes = (sent: unknown[]): Route[] => [
    (c) =>
      c.method === "GET" && c.url.pathname.endsWith("/videos")
        ? jsonResponse({ items: [video] })
        : undefined,
    (c) => {
      if (c.method !== "PUT") return undefined;
      sent.push({ part: c.url.searchParams.get("part"), body: c.body });
      return jsonResponse(c.body);
    },
  ];

  it("merges a title change into the current snippet, so tags and description survive", async () => {
    const sent: { part: string; body: Record<string, Record<string, unknown>> }[] = [];
    const h = await connect(WRITE_ENV, { routes: routes(sent) });
    const res = await h.call("youtube_update_video", { video_id: "abcdefghijk", title: "New" });
    expect(res.isToolError).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.part).toBe("snippet");
    expect(sent[0]?.body.snippet).toEqual({
      title: "New",
      description: "Keep me",
      tags: ["a", "b"],
      categoryId: "28",
    });
  });

  it("sends only writable status fields, and never madeForKids unless asked", async () => {
    const sent: { part: string; body: Record<string, Record<string, unknown>> }[] = [];
    const h = await connect(WRITE_ENV, { routes: routes(sent) });
    await h.call("youtube_update_video", { video_id: "abcdefghijk", privacy: "unlisted" });
    expect(sent[0]?.part).toBe("status");
    expect(sent[0]?.body.status).toEqual({ privacyStatus: "unlisted", embeddable: true });
  });

  it("refuses publishAt on a video being made public", async () => {
    const h = await connect(WRITE_ENV, { routes: routes([]) });
    const res = await h.call("youtube_update_video", {
      video_id: "abcdefghijk",
      privacy: "public",
      publishAt: "2099-01-01T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("private");
  });
});

describe("youtube_delete_video", () => {
  it("cannot be called without confirm: true", async () => {
    const h = await connect(WRITE_ENV);
    const res = await h.call("youtube_delete_video", { video_id: "abcdefghijk" });
    expect(res.isToolError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe("youtube_request", () => {
  it("refuses a path that is not under the Data API", async () => {
    const h = await connect(CLIENT_ENV);
    for (const path of ["https://evil.example/x", "/../oauth2/v1/userinfo", "/videos?part=id"]) {
      const res = await h.call("youtube_request", { path });
      expect(res.isToolError, path).toBe(true);
    }
  });

  it("rejects POST at the schema layer when writes are off", async () => {
    const res = await (
      await connect(CLIENT_ENV)
    ).call("youtube_request", { method: "POST", path: "/playlists" });
    expect(res.isToolError).toBe(true);
  });
});

describe("Google error envelopes", () => {
  it("lifts the reason and a remedy to the top of the tool error", async () => {
    const h = await connect(CLIENT_ENV, {
      routes: [
        (c) =>
          c.url.pathname.endsWith("/playlists")
            ? jsonResponse(
                {
                  error: {
                    code: 403,
                    message:
                      "The request cannot be completed because you have exceeded your quota.",
                    errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }],
                  },
                },
                { status: 403 },
              )
            : undefined,
      ],
    });
    const res = await h.call("youtube_list_playlists");
    expect(res.isToolError).toBe(true);
    expect(res.reason).toBe("quotaExceeded");
    expect(String(res.remedy)).toContain("midnight Pacific");
    // quotaExceeded is final: no retry was attempted.
    expect(h.calls.filter((c) => c.url.pathname.endsWith("/playlists"))).toHaveLength(1);
  });
});

describe("review regressions (2026-11-10)", () => {
  it("does not retry a POST on a 5xx, which may have committed", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [
        (c) =>
          c.method === "POST" && c.url.pathname.endsWith("/playlists")
            ? new Response("oops", { status: 500 })
            : undefined,
      ],
    });
    const res = await h.call("youtube_create_playlist", { title: "x" });
    expect(res.isToolError).toBe(true);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("treats a 404 on a retried DELETE as the delete having happened", async () => {
    let deletes = 0;
    const h = await connect(WRITE_ENV, {
      routes: [
        (c) =>
          c.method === "GET" && c.url.pathname.endsWith("/videos")
            ? jsonResponse({ items: [{ id: "abcdefghijk", snippet: { title: "t" } }] })
            : undefined,
        (c) => {
          if (c.method !== "DELETE") return undefined;
          deletes += 1;
          return deletes === 1
            ? new Response("oops", { status: 503 })
            : jsonResponse(
                { error: { code: 404, errors: [{ reason: "videoNotFound" }] } },
                { status: 404 },
              );
        },
      ],
    });
    const res = await h.call("youtube_delete_video", { video_id: "abcdefghijk", confirm: true });
    expect(res.isToolError).toBe(false);
    expect(res.deleted).toBe("abcdefghijk");
  }, 10_000);

  it("refuses percent-encoded traversal out of /youtube/v3", async () => {
    const h = await connect(CLIENT_ENV);
    for (const path of [
      "/%2e%2e/%2e%2e/upload/youtube/v3/videos",
      "/.%2e/.%2e/oauth2/v3/userinfo",
    ]) {
      const res = await h.call("youtube_request", { path });
      expect(res.isToolError, path).toBe(true);
    }
    expect(h.calls.filter((c) => !c.url.pathname.endsWith("/channels"))).toHaveLength(0);
  });

  it("carries selfDeclaredMadeForKids over in a status update", async () => {
    const sent: unknown[] = [];
    const h = await connect(WRITE_ENV, {
      routes: [
        (c) =>
          c.method === "GET" && c.url.pathname.endsWith("/videos")
            ? jsonResponse({
                items: [
                  {
                    id: "abcdefghijk",
                    snippet: { title: "t", categoryId: "22" },
                    status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
                  },
                ],
              })
            : undefined,
        (c) => (c.method === "PUT" ? (sent.push(c.body), jsonResponse(c.body)) : undefined),
      ],
    });
    await h.call("youtube_update_video", { video_id: "abcdefghijk", privacy: "unlisted" });
    expect((sent[0] as { status: Record<string, unknown> }).status.selfDeclaredMadeForKids).toBe(
      false,
    );
  });
});
