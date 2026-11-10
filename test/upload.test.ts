import { describe, expect, it } from "vitest";

import {
  CHANNEL,
  connect,
  jsonResponse,
  tempFile,
  WRITE_ENV,
  type Call,
  type Route,
} from "#test/helpers";

const SESSION =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION";
const MiB = 1024 * 1024;

type Behaviour = {
  /** Called for each chunk PUT; return a Response to override the default. */
  onChunk?: (call: Call, index: number) => Response | undefined;
  /** Status for the final video resource. */
  returnedPrivacy?: string;
};

/** A fake resumable endpoint that tracks received bytes like Google does. */
const uploadServer = (b: Behaviour = {}) => {
  let received = 0;
  let chunkIndex = 0;
  const chunks: string[] = [];
  const route: Route = (call) => {
    if (call.method === "POST" && call.url.pathname === "/upload/youtube/v3/videos") {
      return new Response(null, { status: 200, headers: { Location: SESSION } });
    }
    if (call.method === "PUT" && call.url.toString() === SESSION) {
      const range = call.headers["content-range"] ?? "";
      if (range.startsWith("bytes */")) {
        return new Response(null, {
          status: 308,
          headers: received > 0 ? { Range: `bytes=0-${received - 1}` } : {},
        });
      }
      chunks.push(range);
      const override = b.onChunk?.(call, chunkIndex++);
      if (override) return override;
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (!m) throw new Error(`bad Content-Range ${range}`);
      const [, start, end, total] = m.map(Number);
      // Contiguity is what Google enforces: a gap or overlap discards the upload.
      if (start !== received) throw new Error(`non-contiguous chunk ${range}, have ${received}`);
      received = (end as number) + 1;
      if (received < (total as number)) {
        return new Response(null, { status: 308, headers: { Range: `bytes=0-${received - 1}` } });
      }
      return jsonResponse({
        id: "abcdefghijk",
        status: { privacyStatus: b.returnedPrivacy ?? "private", uploadStatus: "uploaded" },
      });
    }
    return undefined;
  };
  return { route, chunks, received: () => received };
};

const baseArgs = (file: string) => ({
  file_path: file,
  title: "Demo",
  madeForKids: false,
  wait_seconds: 10,
});

const thumbRoute: Route = (c) =>
  c.url.pathname.endsWith("/thumbnails/set")
    ? jsonResponse({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, { status: 403 })
    : undefined;

describe("youtube_upload_video", () => {
  it("uploads in 256 KiB-aligned chunks and returns the finished video", async () => {
    const server = uploadServer();
    const h = await connect(
      { ...WRITE_ENV, YOUTUBE_CHUNK_SIZE_MB: "1" },
      { routes: [server.route] },
    );
    const file = tempFile("demo.mp4", Math.round(2.5 * MiB));
    const res = await h.call("youtube_upload_video", baseArgs(file));

    expect(res.isToolError).toBe(false);
    expect(res.state).toBe("succeeded");
    expect(res.channel).toEqual(CHANNEL);
    expect(res.video).toMatchObject({
      id: "abcdefghijk",
      privacy: "private",
      requested_privacy: "private",
    });
    expect(server.chunks).toEqual([
      `bytes 0-${MiB - 1}/${2.5 * MiB}`,
      `bytes ${MiB}-${2 * MiB - 1}/${2.5 * MiB}`,
      `bytes ${2 * MiB}-${2.5 * MiB - 1}/${2.5 * MiB}`,
    ]);
  });

  it("sends the metadata with private as the default and the audience declaration", async () => {
    const server = uploadServer();
    const h = await connect(WRITE_ENV, { routes: [server.route] });
    await h.call("youtube_upload_video", baseArgs(tempFile("demo.mov", 1000)));
    const init = h.calls.find((c) => c.method === "POST" && c.url.pathname.startsWith("/upload"));
    expect(init?.url.searchParams.get("part")).toBe("snippet,status");
    expect(init?.headers["x-upload-content-type"]).toBe("video/quicktime");
    expect(init?.headers["x-upload-content-length"]).toBe("1000");
    expect(init?.body).toEqual({
      snippet: { title: "Demo", categoryId: "22" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    });
  });

  it("requires madeForKids rather than guessing it", async () => {
    const h = await connect(WRITE_ENV, { routes: [uploadServer().route] });
    const { madeForKids: _omit, ...args } = baseArgs(tempFile("demo.mp4", 10));
    const res = await h.call("youtube_upload_video", args);
    expect(res.isToolError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("resumes from the server's Range after a 503, instead of resending from zero", async () => {
    const server = uploadServer({
      onChunk: (_c, i) => (i === 1 ? new Response("busy", { status: 503 }) : undefined),
    });
    const h = await connect(
      { ...WRITE_ENV, YOUTUBE_CHUNK_SIZE_MB: "1" },
      { routes: [server.route] },
    );
    const res = await h.call("youtube_upload_video", {
      ...baseArgs(tempFile("demo.mp4", 2 * MiB)),
      wait_seconds: 30,
    });
    expect(res.state).toBe("succeeded");
    expect(res.resumes).toBe(1);
    // The status query happened, and the second chunk was resent from 1 MiB.
    expect(h.calls.some((c) => c.headers["content-range"] === `bytes */${2 * MiB}`)).toBe(true);
    expect(server.chunks.filter((r) => r.startsWith(`bytes ${MiB}-`))).toHaveLength(2);
  }, 20_000);

  it("reports an expired session (404) as unresumable", async () => {
    const server = uploadServer({ onChunk: () => new Response(null, { status: 404 }) });
    const h = await connect(WRITE_ENV, { routes: [server.route] });
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 100)));
    expect(res.state).toBe("failed");
    expect((res.error as { message: string }).message).toContain("expired");
    expect((res.error as { remedy: string }).remedy).toContain("Nothing was published");
  });

  it("warns when YouTube sets a different privacy than requested", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [uploadServer({ returnedPrivacy: "private" }).route],
    });
    const res = await h.call("youtube_upload_video", {
      ...baseArgs(tempFile("demo.mp4", 100)),
      privacy: "unlisted",
    });
    expect(res.state).toBe("succeeded");
    expect((res.warnings as string[])[0]).toContain('"unlisted"');
  });

  it("keeps a failed thumbnail a warning: the video exists and must not be re-uploaded", async () => {
    const h = await connect(WRITE_ENV, { routes: [uploadServer().route, thumbRoute] });
    const res = await h.call("youtube_upload_video", {
      ...baseArgs(tempFile("demo.mp4", 100)),
      thumbnailPath: tempFile("thumb.jpg", 50),
    });
    expect(res.state).toBe("succeeded");
    expect((res.warnings as string[]).join(" ")).toContain("youtube.com/verify");
  });

  it("returns an upload_id when the wait runs out, and youtube_get_upload follows it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const server = uploadServer();
    const slow: Route = (c) =>
      c.method === "PUT" && !(c.headers["content-range"] ?? "").startsWith("bytes */")
        ? gate.then(() => server.route(c) as Response)
        : undefined;
    const h = await connect(WRITE_ENV, {
      routes: [
        slow,
        server.route,
        (c) =>
          c.url.pathname.endsWith("/videos")
            ? jsonResponse({
                items: [
                  {
                    status: { uploadStatus: "processed", privacyStatus: "private" },
                    processingDetails: { processingStatus: "succeeded" },
                  },
                ],
              })
            : undefined,
      ],
    });
    const started = await h.call("youtube_upload_video", {
      ...baseArgs(tempFile("demo.mp4", 100)),
      wait_seconds: 0,
    });
    expect(started.state).toBe("uploading");
    expect(String(started.next_step)).toContain("do NOT call youtube_upload_video again");

    release();
    const done = await h.call("youtube_get_upload", {
      upload_id: started.upload_id,
      wait_seconds: 5,
    });
    expect(done.state).toBe("succeeded");
    expect(done.processing).toMatchObject({ status: "succeeded", upload_status: "processed" });
  });

  it("refuses files that are not videos, so a path from a model cannot publish ~/.ssh", async () => {
    const h = await connect(WRITE_ENV, { routes: [uploadServer().route] });
    const key = await h.call("youtube_upload_video", baseArgs(tempFile("id_ed25519", 100)));
    expect(key.isToolError).toBe(true);
    expect(String(key.error)).toContain("does not look like a video file");
    const relative = await h.call("youtube_upload_video", baseArgs("movies/demo.mp4"));
    expect(String(relative.error)).toContain("absolute");
    expect(h.calls).toHaveLength(0);
  });

  it("refuses publishAt with a non-private privacy before uploading anything", async () => {
    const h = await connect(WRITE_ENV, { routes: [uploadServer().route] });
    const res = await h.call("youtube_upload_video", {
      ...baseArgs(tempFile("demo.mp4", 10)),
      privacy: "public",
      publishAt: "2099-01-01T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses to upload to the wrong channel", async () => {
    const h = await connect(
      { ...WRITE_ENV, YOUTUBE_CHANNEL_ID: "UCzzzzzzzzzzzzzzzzzzzzzz" },
      { routes: [uploadServer().route] },
    );
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 10)));
    expect(res.isToolError).toBe(true);
    expect(h.calls.some((c) => c.url.pathname.startsWith("/upload"))).toBe(false);
  });
});

/** Every status check answers 503. */
const failingProbes: Route = (c) =>
  (c.headers["content-range"] ?? "").startsWith("bytes */")
    ? new Response("busy", { status: 503 })
    : undefined;

/** Regressions from the 2026-11-10 review, one per finding. */
describe("upload engine edge cases", () => {
  it("ends in `unknown`, not `failed`, when the final chunk's answer and the status checks are lost", async () => {
    const server = uploadServer({
      onChunk: () => {
        throw new TypeError("fetch failed");
      },
    });
    const h = await connect(WRITE_ENV, { routes: [failingProbes, server.route] });
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 100)));
    expect(res.state).toBe("unknown");
    expect(String(res.next_step)).toContain("BEFORE uploading again");
    expect(String((res.error as { remedy: string }).remedy)).toContain("youtube_list_videos");
  });

  it("recovers the video from a status check when a 200 arrives without a body", async () => {
    let finished = false;
    const route: Route = (c) => {
      if (c.method === "POST" && c.url.pathname === "/upload/youtube/v3/videos") {
        return new Response(null, { status: 200, headers: { Location: SESSION } });
      }
      if (c.method !== "PUT" || c.url.toString() !== SESSION) return undefined;
      if ((c.headers["content-range"] ?? "").startsWith("bytes */")) {
        return finished
          ? jsonResponse({ id: "abcdefghijk", status: { privacyStatus: "private" } })
          : new Response(null, { status: 308 });
      }
      finished = true;
      return new Response(null, { status: 201 });
    };
    const h = await connect(WRITE_ENV, { routes: [route] });
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 100)));
    expect(res.state).toBe("succeeded");
    expect(res.video).toMatchObject({ id: "abcdefghijk" });
  });

  it("bounds a 308 that never moves forward instead of looping forever", async () => {
    const server = uploadServer({ onChunk: () => new Response(null, { status: 308 }) });
    const h = await connect(WRITE_ENV, { routes: [server.route] });
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 100)));
    expect(res.state).toBe("failed");
    expect(server.chunks.length).toBeLessThan(20);
  });

  it("treats a 429 on a chunk as transient and resumes", async () => {
    const server = uploadServer({
      onChunk: (_c, i) => (i === 0 ? new Response("slow down", { status: 429 }) : undefined),
    });
    const h = await connect(WRITE_ENV, { routes: [server.route] });
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 100)));
    expect(res.state).toBe("succeeded");
    expect(res.resumes).toBe(1);
  });

  it("asks for the outcome rather than sending an empty chunk when every byte has arrived", async () => {
    let probed = false;
    const server = uploadServer({
      // The chunk lands, but the reply is lost.
      onChunk: () => {
        throw new TypeError("fetch failed");
      },
    });
    const route: Route = (c) => {
      if (c.method === "PUT" && (c.headers["content-range"] ?? "").startsWith("bytes */")) {
        if (!probed) {
          probed = true;
          return new Response(null, { status: 308, headers: { Range: "bytes=0-99" } });
        }
        return jsonResponse({ id: "abcdefghijk", status: { privacyStatus: "private" } });
      }
      return undefined;
    };
    const h = await connect(WRITE_ENV, { routes: [route, server.route] });
    const res = await h.call("youtube_upload_video", baseArgs(tempFile("demo.mp4", 100)));
    expect(res.state).toBe("succeeded");
    expect(server.chunks.some((r) => r.startsWith("bytes 100-"))).toBe(false);
  });

  it("returns the existing upload for the same file, title and channel unless forced", async () => {
    const server = uploadServer();
    const h = await connect(WRITE_ENV, { routes: [server.route] });
    const file = tempFile("demo.mp4", 100);
    const first = await h.call("youtube_upload_video", baseArgs(file));
    const second = await h.call("youtube_upload_video", baseArgs(file));
    expect(second.duplicate_of_existing_upload).toBe(true);
    expect(second.upload_id).toBe(first.upload_id);
    const sessions = () =>
      h.calls.filter((c) => c.method === "POST" && c.url.pathname.startsWith("/upload")).length;
    expect(sessions()).toBe(1);
    await h.call("youtube_upload_video", { ...baseArgs(file), force: true });
    expect(sessions()).toBe(2);
  });

  it("validates thumbnailPath before spending an upload", async () => {
    const h = await connect(WRITE_ENV, { routes: [uploadServer().route] });
    const res = await h.call("youtube_upload_video", {
      ...baseArgs(tempFile("demo.mp4", 100)),
      thumbnailPath: "/nonexistent/thumb.gif",
    });
    expect(res.isToolError).toBe(true);
    expect(h.calls.some((c) => c.url.pathname.startsWith("/upload"))).toBe(false);
  });

  it("refuses a symlink named .mp4 that points at a non-video, and a renamed non-video", async () => {
    const { symlinkSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const secret = tempFile(
      "id_ed25519",
      new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----"),
    );
    const link = join(dirname(secret), "demo.mp4");
    symlinkSync(secret, link);
    const renamed = tempFile("notes.mp4", new TextEncoder().encode("just some text, not a video"));
    const h = await connect(WRITE_ENV, { routes: [uploadServer().route] });
    const viaLink = await h.call("youtube_upload_video", baseArgs(link));
    expect(String(viaLink.error)).toContain("link");
    const viaRename = await h.call("youtube_upload_video", baseArgs(renamed));
    expect(String(viaRename.error)).toContain("contents are not");
    expect(h.calls).toHaveLength(0);
  });
});
