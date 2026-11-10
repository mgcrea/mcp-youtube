// The context-window layer. A YouTube video resource repeats its title and
// description under `localized`, carries five thumbnail sizes with their
// dimensions, and wraps counters as strings. List tools return the summarized
// form plus the page token; get tools return the full object with only that
// redundancy removed.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rec = (value: unknown): Rec => (isRecord(value) ? value : {});

const num = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

/** Drop undefined values, so a summary never carries `"x": null` noise. */
export const compact = <T extends Rec>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/** ISO 8601 duration (`PT1H2M3S`, `P1DT2H`) to seconds. */
export const durationSeconds = (iso: unknown): number | undefined => {
  if (typeof iso !== "string") return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return undefined;
  const [, d, h, min, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (s ?? 0);
};

/** The largest thumbnail URL on offer, instead of five sizes with dimensions. */
export const bestThumbnail = (thumbnails: unknown): string | undefined => {
  const t = rec(thumbnails);
  for (const key of ["maxres", "uhd", "qhd", "fhd", "standard", "high", "medium", "default"]) {
    const url = rec(t[key]).url;
    if (typeof url === "string") return url;
  }
  return undefined;
};

export const watchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
export const studioUrl = (id: string): string => `https://studio.youtube.com/video/${id}/edit`;

/** One row of youtube_list_videos. */
export const summarizeVideo = (video: unknown): Rec => {
  const v = rec(video);
  const id = String(v.id ?? "");
  const snippet = rec(v.snippet);
  const status = rec(v.status);
  const stats = rec(v.statistics);
  const details = rec(v.contentDetails);
  return compact({
    id,
    title: snippet.title as string | undefined,
    published_at: snippet.publishedAt as string | undefined,
    privacy: status.privacyStatus as string | undefined,
    publish_at: status.publishAt as string | undefined,
    upload_status: status.uploadStatus as string | undefined,
    // Only present when something went wrong, and then it is the whole story.
    failure_reason: status.failureReason as string | undefined,
    rejection_reason: status.rejectionReason as string | undefined,
    // YouTube reports P0D until processing finishes; 0 would read as an empty video.
    duration_seconds: durationSeconds(details.duration) || undefined,
    views: num(stats.viewCount),
    likes: num(stats.likeCount),
    comments: num(stats.commentCount),
    url: id ? watchUrl(id) : undefined,
  });
};

/**
 * The full video for youtube_get_video: every part, minus the copies. The
 * `localized` block restates title and description unless a translation is
 * set, and thumbnails collapse to the best URL.
 */
export const fullVideo = (video: unknown): Rec => {
  const v = rec(video);
  const id = String(v.id ?? "");
  const snippet = { ...rec(v.snippet) };
  const localized = rec(snippet.localized);
  if (localized.title === snippet.title && localized.description === snippet.description) {
    delete snippet.localized;
  }
  const thumbnail = bestThumbnail(snippet.thumbnails);
  delete snippet.thumbnails;
  const stats = rec(v.statistics);
  return compact({
    id,
    url: id ? watchUrl(id) : undefined,
    studio_url: id ? studioUrl(id) : undefined,
    snippet: { ...snippet, ...(thumbnail ? { thumbnail } : {}) },
    status: v.status,
    contentDetails: isRecord(v.contentDetails)
      ? { ...v.contentDetails, duration_seconds: durationSeconds(v.contentDetails.duration) }
      : undefined,
    statistics: isRecord(v.statistics)
      ? Object.fromEntries(Object.entries(stats).map(([k, val]) => [k, num(val) ?? val]))
      : undefined,
    processingDetails: v.processingDetails,
    fileDetails: v.fileDetails,
    suggestions: v.suggestions,
  });
};

export const summarizePlaylist = (playlist: unknown): Rec => {
  const p = rec(playlist);
  const snippet = rec(p.snippet);
  return compact({
    id: p.id as string | undefined,
    title: snippet.title as string | undefined,
    description: (snippet.description as string | undefined) || undefined,
    privacy: rec(p.status).privacyStatus as string | undefined,
    item_count: num(rec(p.contentDetails).itemCount),
    published_at: snippet.publishedAt as string | undefined,
  });
};

export const summarizeChannel = (channel: unknown): Rec => {
  const c = rec(channel);
  const snippet = rec(c.snippet);
  const stats = rec(c.statistics);
  const status = rec(c.status);
  const id = c.id as string | undefined;
  return compact({
    id,
    title: snippet.title as string | undefined,
    handle: snippet.customUrl as string | undefined,
    url: id ? `https://www.youtube.com/channel/${id}` : undefined,
    country: snippet.country as string | undefined,
    uploads_playlist_id: rec(rec(c.contentDetails).relatedPlaylists).uploads as string | undefined,
    subscribers: stats.hiddenSubscriberCount === true ? undefined : num(stats.subscriberCount),
    videos: num(stats.videoCount),
    views: num(stats.viewCount),
    privacy: status.privacyStatus as string | undefined,
    // `allowed`/`eligible` vs `disallowed`: without phone verification a channel
    // cannot upload anything longer than 15 minutes, and the upload fails late.
    long_uploads: status.longUploadsStatus as string | undefined,
    made_for_kids: status.madeForKids as boolean | undefined,
  });
};
