import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";

import type { Logger } from "#/client/auth";
import { PreconditionError, YoutubeApiError } from "#/client/errors";
import { studioUrl, watchUrl, type Rec } from "#/client/shape";
import {
  apiError,
  backoffMs,
  isTransient,
  parseBody,
  retryAfterMs,
  sleep,
  type YoutubeClient,
} from "#/client/youtube";
import type { LocalFile } from "#/upload/files";
import { readImageFile } from "#/upload/files";

/**
 * The resumable upload protocol, from
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol:
 *
 * 1. POST the metadata to /upload/youtube/v3/videos?uploadType=resumable with
 *    X-Upload-Content-Length/-Type; the session URI comes back in `Location`.
 * 2. PUT the bytes to the session URI in chunks, each with
 *    `Content-Range: bytes first-last/total`. Every chunk but the last must be
 *    a multiple of 256 KiB, and all but the last the same size. A non-final
 *    chunk answers 308 Resume Incomplete with `Range: bytes=0-<last received>`.
 *    The final one answers 200/201 with the video resource.
 * 3. After a 5xx or a dropped connection, ask where the server got to with an
 *    empty PUT carrying `Content-Range: bytes * /total` (no space; written with
 *    one here only because it would close this comment), and resume from one
 *    past the end of its `Range`. Bytes must be contiguous: an overlap or a gap
 *    discards the whole upload.
 * 4. A 404 means the session expired. It cannot be resumed; start again.
 *
 * Chunking is what makes progress visible and lets a dropped connection cost
 * one chunk rather than the whole file. Google discourages it for speed, which
 * matters less than either of those here.
 */
export const CHUNK_GRANULARITY = 256 * 1024;

export type VideoSnippet = {
  title: string;
  description?: string;
  tags?: string[];
  categoryId: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
};

export type VideoStatus = {
  privacyStatus: "private" | "unlisted" | "public";
  publishAt?: string;
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia?: boolean;
  embeddable?: boolean;
  license?: "youtube" | "creativeCommon";
};

export type UploadRequest = {
  file: LocalFile;
  snippet: VideoSnippet;
  status: VideoStatus;
  notifySubscribers: boolean;
  playlistId?: string;
  thumbnailPath?: string;
  channel: { id: string; title: string };
};

/**
 * `unknown` is its own state on purpose: the last chunk went out and the answer
 * was lost, so the video may exist. Calling that `failed` would invite a
 * re-upload, and a second videos.insert is a second video.
 */
export type UploadState = "uploading" | "finishing" | "succeeded" | "failed" | "unknown";

export type UploadJob = {
  id: string;
  state: UploadState;
  request: UploadRequest;
  /** Identifies "the same upload" for the duplicate guard. */
  key: string;
  bytesSent: number;
  startedAt: number;
  finishedAt?: number;
  /** Times the transfer was interrupted and resumed. */
  resumes: number;
  video?: Rec;
  error?: { message: string; remedy?: string; status?: number; reason?: string };
  warnings: string[];
  done: Promise<void>;
};

const errorOf = (err: unknown): NonNullable<UploadJob["error"]> => {
  if (err instanceof YoutubeApiError) {
    return {
      message: err.message,
      status: err.status,
      ...(err.reason ? { reason: err.reason } : {}),
      ...(err.remedy ? { remedy: err.remedy } : {}),
    };
  }
  if (err instanceof PreconditionError) {
    return { message: err.message, ...(err.remedy ? { remedy: err.remedy } : {}) };
  }
  return { message: err instanceof Error ? err.message : String(err) };
};

/** `bytes=0-1048575` → 1048576, the next byte to send. No header means nothing arrived. */
export const nextOffsetFromRange = (range: string | null): number => {
  if (!range) return 0;
  const m = /bytes=\d+-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
};

/** A dropped socket surfaces as a TypeError from fetch, a timeout as an AbortError/TimeoutError. */
const isNetworkError = (err: unknown): boolean =>
  err instanceof TypeError ||
  (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));

class SessionExpiredError extends YoutubeApiError {
  constructor() {
    super("The upload session expired (HTTP 404 on the session URI). It cannot be resumed.", {
      status: 404,
      remedy:
        "Call youtube_upload_video again to start over. Nothing was published: an upload that " +
        "never completed does not create a video.",
    });
  }
}

/** The final chunk was sent and no definitive answer came back. */
export class OutcomeUnknownError extends Error {
  override readonly name = "OutcomeUnknownError";
  constructor(cause: unknown) {
    super(
      "Every byte was sent, but YouTube's answer to the last chunk was lost " +
        `(${cause instanceof Error ? cause.message : String(cause)}). The video may or may not exist.`,
      { cause },
    );
  }
}

/** One attempt's outcome, classified once so the loop below reads as a state machine. */
type Attempt =
  | { kind: "done"; video: Rec | undefined }
  | { kind: "progress"; offset: number }
  | { kind: "transient"; res?: Response; body?: unknown; error?: unknown }
  | { kind: "expired" }
  | { kind: "rejected"; res: Response; body: unknown };

const hasId = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && typeof (v as Rec).id === "string";

export type UploadEngineOptions = {
  client: YoutubeClient;
  chunkSizeBytes: number;
  /** Consecutive failed attempts tolerated before the job fails. Never below 5 for uploads. */
  maxRetries: number;
  logger?: Logger | undefined;
  now?: () => number;
  /** Per-chunk timeout. A 16 MiB chunk on a slow uplink needs minutes, not seconds. */
  chunkTimeoutMs?: number;
  /** Override the backoff (tests). */
  backoff?: (attempt: number) => number;
};

/** How many finished jobs youtube_get_upload remembers. */
const MAX_FINISHED_JOBS = 50;

const isFinished = (job: UploadJob): boolean =>
  job.state === "succeeded" || job.state === "failed" || job.state === "unknown";

export class UploadEngine {
  private readonly client: YoutubeClient;
  private readonly chunkSize: number;
  private readonly maxRetries: number;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly chunkTimeoutMs: number;
  private readonly backoff: (attempt: number) => number;
  private readonly jobs = new Map<string, UploadJob>();

  constructor(opts: UploadEngineOptions) {
    this.client = opts.client;
    // Round down to the 256 KiB granularity the protocol demands, minimum one unit.
    this.chunkSize = Math.max(
      CHUNK_GRANULARITY,
      Math.floor(opts.chunkSizeBytes / CHUNK_GRANULARITY) * CHUNK_GRANULARITY,
    );
    // An upload is long and the network is the usual failure, so it gets a
    // larger budget than a single API call does.
    this.maxRetries = Math.max(opts.maxRetries, 5);
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.chunkTimeoutMs = opts.chunkTimeoutMs ?? 600_000;
    this.backoff = opts.backoff ?? backoffMs;
  }

  get(id: string): UploadJob | undefined {
    return this.jobs.get(id);
  }

  list(): UploadJob[] {
    return [...this.jobs.values()].toReversed();
  }

  /**
   * A job for the same file, title and channel that is running, finished, or
   * of unknown outcome. The guard exists because the likeliest duplicate is an
   * agent whose client timed out and who calls the upload tool again.
   */
  findDuplicate(key: string): UploadJob | undefined {
    return this.list().find((j) => j.key === key && j.state !== "failed");
  }

  /** Start an upload in the background and return its job at once. */
  start(request: UploadRequest): UploadJob {
    const job: UploadJob = {
      id: `up_${randomBytes(6).toString("hex")}`,
      state: "uploading",
      request,
      key: uploadKey(request),
      bytesSent: 0,
      startedAt: this.now(),
      resumes: 0,
      warnings: [],
      done: Promise.resolve(),
    };
    job.done = this.run(job).catch((err: unknown) => {
      job.state = err instanceof OutcomeUnknownError ? "unknown" : "failed";
      job.error = {
        ...errorOf(err),
        ...(err instanceof OutcomeUnknownError
          ? {
              remedy:
                `Look for "${request.snippet.title}" in YouTube Studio (https://studio.youtube.com) ` +
                "before uploading again. youtube_list_videos lags by a minute or more after an upload " +
                "(the uploads playlist is eventually consistent), so its absence there right away " +
                "proves nothing. If it is still missing after a few minutes, upload again.",
            }
          : {}),
      };
      job.finishedAt = this.now();
      this.logger?.warn?.(`upload ${job.id} ${job.state}: ${job.error.message}`);
    });
    this.jobs.set(job.id, job);
    this.prune();
    return job;
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(isFinished);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
      this.jobs.delete(job.id);
    }
  }

  private async run(job: UploadJob): Promise<void> {
    const { request } = job;
    const sessionUri = await this.createSession(request);
    const video = await this.transfer(job, sessionUri);
    job.state = "finishing";
    job.video = video;
    const videoId = String(video.id);

    // From here on the video EXISTS. Nothing below may fail the job, and
    // nothing may retry the upload: a second videos.insert is a second video.
    const returned = (video.status as Rec | undefined)?.privacyStatus;
    if (returned && returned !== request.status.privacyStatus) {
      job.warnings.push(
        `Requested privacy "${request.status.privacyStatus}" but YouTube set "${String(returned)}". ` +
          "The channel's upload defaults or an account restriction can force this; check YouTube Studio.",
      );
    }
    if (request.thumbnailPath) {
      try {
        await setThumbnail(this.client, videoId, request.thumbnailPath);
      } catch (err) {
        const e = errorOf(err);
        job.warnings.push(
          `The video uploaded, but the thumbnail was not set: ${e.message}` +
            (e.remedy ? ` ${e.remedy}` : "") +
            " Retry with youtube_set_thumbnail.",
        );
      }
    }
    if (request.playlistId) {
      try {
        await addToPlaylist(this.client, request.playlistId, videoId);
      } catch (err) {
        job.warnings.push(
          `The video uploaded, but was not added to playlist ${request.playlistId}: ` +
            `${errorOf(err).message} Retry with youtube_add_to_playlist.`,
        );
      }
    }
    job.state = "succeeded";
    job.finishedAt = this.now();
    this.logger?.warn?.(`upload ${job.id} finished: video ${videoId}`);
  }

  /** Creating a session creates no video, so retrying it is always safe. */
  private async createSession(request: UploadRequest): Promise<string> {
    const url = new URL(`${this.client.uploadBaseUrl}/videos`);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("part", "snippet,status");
    url.searchParams.set("notifySubscribers", String(request.notifySubscribers));

    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await this.client.authedFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(request.file.size),
            "X-Upload-Content-Type": request.file.mimeType,
          },
          body: JSON.stringify({ snippet: request.snippet, status: request.status }),
          signal: AbortSignal.timeout(this.client.timeoutMs),
        });
      } catch (err) {
        if (isNetworkError(err) && attempt < this.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
      if (res.ok) {
        await res.body?.cancel();
        const location = res.headers.get("Location");
        if (!location) {
          throw new Error("Google started the upload session but returned no Location header.");
        }
        return location;
      }
      const body = parseBody(await res.text());
      if (isTransient(res.status, body) && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res) ?? this.backoff(attempt));
        continue;
      }
      throw apiError("Starting the upload (videos.insert)", res, body);
    }
  }

  /** Classify a session response. Never throws for a body that cannot be read. */
  private async classify(res: Response): Promise<Attempt> {
    if (res.status === 308) {
      await res.body?.cancel().catch(() => {});
      return { kind: "progress", offset: nextOffsetFromRange(res.headers.get("Range")) };
    }
    let body: unknown;
    try {
      body = parseBody(await res.text());
    } catch (error) {
      // A 200 whose body stream breaks still means the video exists.
      if (res.status === 200 || res.status === 201) return { kind: "done", video: undefined };
      return { kind: "transient", res, error };
    }
    if (res.status === 200 || res.status === 201) {
      return { kind: "done", video: hasId(body) ? body : undefined };
    }
    if (res.status === 404) return { kind: "expired" };
    if (isTransient(res.status, body)) return { kind: "transient", res, body };
    return { kind: "rejected", res, body };
  }

  /** PUT to the session, classifying network failures as transient. */
  private async put(sessionUri: string, init: RequestInit): Promise<Attempt> {
    try {
      // `manual`: fetch would follow a 308 carrying a Location header and resend
      // the chunk there. Google's 308 means "resume incomplete", not a redirect.
      return await this.classify(
        await this.client.authedFetch(sessionUri, { ...init, method: "PUT", redirect: "manual" }),
      );
    } catch (error) {
      if (isNetworkError(error)) return { kind: "transient", error };
      throw error;
    }
  }

  /** Ask the session how many bytes it holds, retrying the question itself. */
  private async probe(sessionUri: string, total: number): Promise<Attempt> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.put(sessionUri, {
        headers: { "Content-Range": `bytes */${total}` },
        signal: AbortSignal.timeout(this.client.timeoutMs),
      });
      if (result.kind !== "transient" || attempt >= this.maxRetries) return result;
      await sleep((result.res && retryAfterMs(result.res)) ?? this.backoff(attempt));
    }
  }

  private async transfer(job: UploadJob, sessionUri: string): Promise<Rec> {
    const { file } = job.request;
    const total = file.size;
    const handle = await open(file.realPath, "r");
    let failures = 0;
    let offset = 0;
    // Set once YouTube may have created the video without our hearing about
    // it: the final chunk went out and the answer was lost or a 5xx, or the
    // session reported every byte received. From then on any ending that is
    // not a confirmed video is "unknown", never "failed". A 404 or 4xx that
    // directly answers the final chunk is definitive and leaves this false.
    let ambiguous = false;
    const giveUp = (cause: unknown): never => {
      throw ambiguous ? new OutcomeUnknownError(cause) : cause;
    };
    try {
      for (;;) {
        let result: Attempt;
        let finalAttempt = false;
        if (offset >= total) {
          ambiguous = true;
          // The server reports every byte received, so there is nothing left to
          // send — an empty "bytes 100-99/100" chunk would be invalid. Ask for
          // the outcome instead.
          result = await this.probe(sessionUri, total);
        } else {
          const end = Math.min(offset + this.chunkSize, total);
          const chunk = new Uint8Array(end - offset);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
          if (bytesRead !== chunk.length) {
            throw new PreconditionError(
              `${file.path} changed size during the upload (read ${bytesRead} of ${chunk.length} bytes at offset ${offset}).`,
              { remedy: "Wait until the file is fully written, then upload it again." },
            );
          }
          finalAttempt = end === total;
          result = await this.put(sessionUri, {
            headers: {
              "Content-Type": file.mimeType,
              "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
            },
            body: chunk as unknown as NonNullable<RequestInit["body"]>,
            signal: AbortSignal.timeout(this.chunkTimeoutMs),
          });
        }

        if (finalAttempt && result.kind === "transient") ambiguous = true;

        switch (result.kind) {
          case "done": {
            job.bytesSent = total;
            ambiguous = true;
            if (result.video) return result.video;
            // Finished, but the resource did not come through: ask again once.
            const again = await this.probe(sessionUri, total);
            if (again.kind === "done" && again.video) return again.video;
            return giveUp(new Error("YouTube confirmed the upload but returned no video resource"));
          }
          case "progress": {
            if (result.offset > offset) {
              offset = result.offset;
              job.bytesSent = offset;
              failures = 0;
              continue;
            }
            // A 308 that moved nothing forward is a failure too; resetting the
            // counter on it once made a missing Range header loop forever.
            break;
          }
          case "expired":
            return giveUp(new SessionExpiredError());
          case "rejected":
            // A definitive 4xx on a chunk: YouTube refused it, so no video exists.
            throw apiError("Uploading the video bytes", result.res, result.body);
          case "transient":
            this.logger?.warn?.(`upload ${job.id}: interrupted at ${offset}/${total}`);
            break;
        }

        failures += 1;
        if (failures > this.maxRetries) {
          const last =
            result.kind === "transient" && result.res
              ? apiError("Uploading the video bytes", result.res, result.body)
              : new Error(`The upload to YouTube kept failing (${failures} times in a row).`);
          return giveUp(last);
        }
        await sleep(
          (result.kind === "transient" && result.res && retryAfterMs(result.res)) ||
            this.backoff(failures - 1),
        );
        job.resumes += 1;
        const where = await this.probe(sessionUri, total);
        if (where.kind === "done") {
          job.bytesSent = total;
          ambiguous = true;
          if (where.video) return where.video;
          return giveUp(new Error("YouTube confirmed the upload but returned no video resource"));
        }
        if (where.kind === "progress") {
          // Even when this does not move forward, the next chunk attempt is
          // what decides; the failure counter above bounds the loop.
          offset = where.offset;
          job.bytesSent = offset;
          continue;
        }
        if (where.kind === "expired") return giveUp(new SessionExpiredError());
        if (where.kind === "rejected") {
          return giveUp(apiError("Checking the upload status", where.res, where.body));
        }
        // Still transient after the probe's own retries: go round again; the
        // failure counter bounds it.
      }
    } finally {
      await handle.close();
    }
  }
}

/** The duplicate-guard key: same bytes on disk, same title, same channel. */
export const uploadKey = (r: UploadRequest): string =>
  [r.file.realPath, r.file.size, r.file.mtimeMs, r.snippet.title, r.channel.id].join("\u0000");

/** thumbnails.set. 50 quota units. Custom thumbnails need a verified channel. */
export const setThumbnail = async (
  client: YoutubeClient,
  videoId: string,
  path: string,
): Promise<Rec> => {
  const image = await readImageFile(path);
  try {
    return await client.request<Rec>("POST", "/thumbnails/set", {
      base: "upload",
      query: { videoId, uploadType: "media" },
      raw: { data: image.data, contentType: image.mimeType },
    });
  } catch (err) {
    if (err instanceof YoutubeApiError && err.status === 403 && err.reason === "forbidden") {
      throw new YoutubeApiError(err.message, {
        status: err.status,
        reason: err.reason,
        remedy:
          "Custom thumbnails need a verified channel. Verify by phone at " +
          "https://www.youtube.com/verify, then retry youtube_set_thumbnail.",
        errors: err.errors,
      });
    }
    throw err;
  }
};

/** playlistItems.insert. 50 quota units. */
export const addToPlaylist = (
  client: YoutubeClient,
  playlistId: string,
  videoId: string,
  position?: number,
): Promise<Rec> =>
  client.request<Rec>("POST", "/playlistItems", {
    query: { part: "snippet" },
    body: {
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
        ...(position !== undefined ? { position } : {}),
      },
    },
  });

/** What youtube_upload_video and youtube_get_upload return for a job. */
export const describeJob = (job: UploadJob, now: number = Date.now()): Rec => {
  const total = job.request.file.size;
  const elapsed = ((job.finishedAt ?? now) - job.startedAt) / 1000;
  const rate = elapsed > 0 ? job.bytesSent / elapsed : 0;
  const videoId = job.video?.id as string | undefined;
  const status = (job.video?.status ?? {}) as Rec;
  return {
    upload_id: job.id,
    state: job.state,
    channel: job.request.channel,
    file: job.request.file.path,
    title: job.request.snippet.title,
    bytes_sent: job.bytesSent,
    total_bytes: total,
    percent: Math.round((job.bytesSent / total) * 1000) / 10,
    elapsed_seconds: Math.round(elapsed),
    ...(job.state === "uploading" && rate > 0
      ? {
          rate_mb_per_s: Math.round((rate / 1024 ** 2) * 100) / 100,
          eta_seconds: Math.round((total - job.bytesSent) / rate),
        }
      : {}),
    ...(job.resumes > 0 ? { resumes: job.resumes } : {}),
    ...(videoId
      ? {
          video: {
            id: videoId,
            url: watchUrl(videoId),
            studio_url: studioUrl(videoId),
            privacy: status.privacyStatus,
            requested_privacy: job.request.status.privacyStatus,
            ...(status.publishAt ? { publish_at: status.publishAt } : {}),
            upload_status: status.uploadStatus,
          },
        }
      : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.warnings.length > 0 ? { warnings: job.warnings } : {}),
  };
};
