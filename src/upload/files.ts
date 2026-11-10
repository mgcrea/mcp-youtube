import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import { PreconditionError } from "#/client/errors";
import { expandTilde } from "#/config";

/**
 * The formats YouTube accepts, by extension. Anything else is refused rather
 * than sent as application/octet-stream: the path comes from a model, and a
 * tool that uploads whatever file it is pointed at is a way to publish
 * ~/.ssh/id_ed25519 to the internet. The extension is necessary, not
 * sufficient — see `looksLike` below.
 */
export const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".ts": "video/mp2t",
  ".mts": "video/mp2t",
};

export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** 256 GB, the documented videos.insert maximum. */
export const MAX_VIDEO_BYTES = 256 * 1024 ** 3;
/** Raised from 2 MB to 50 MB on 2026-09-14. */
export const MAX_THUMBNAIL_BYTES = 50 * 1024 ** 2;

export type LocalFile = {
  path: string;
  /** After symlinks: what is actually read, and what the duplicate guard keys on. */
  realPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
};

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * Container signatures, read from the first bytes. A renamed or symlinked file
 * passes an extension check; it does not pass this.
 */
export const looksLike = (mimeType: string, head: Uint8Array): boolean => {
  switch (mimeType) {
    case "video/mp4":
    case "video/x-m4v":
    case "video/3gpp":
    case "video/quicktime":
      // ISO BMFF: a box size, then its type. QuickTime files may open with
      // moov/mdat/wide/free/skip instead of ftyp.
      return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(ascii(head, 4, 8));
    case "video/webm":
    case "video/x-matroska":
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case "video/x-msvideo":
      return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "AVI ";
    case "video/x-ms-wmv":
      return head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75;
    case "video/x-flv":
      return ascii(head, 0, 3) === "FLV";
    case "video/mpeg":
      return (
        head[0] === 0 && head[1] === 0 && head[2] === 1 && (head[3] === 0xba || head[3] === 0xb3)
      );
    case "video/mp2t":
      // 188-byte transport packets each start with the 0x47 sync byte; M2TS
      // (.mts) prefixes each with a 4-byte timestamp.
      return head[0] === 0x47 || head[4] === 0x47;
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/png":
      return head[0] === 0x89 && ascii(head, 1, 4) === "PNG";
    default:
      return false;
  }
};

const resolveFile = async (
  input: string,
  kinds: Record<string, string>,
  what: string,
  maxBytes: number,
): Promise<LocalFile> => {
  const path = expandTilde(input.trim());
  if (!isAbsolute(path)) {
    throw new PreconditionError(
      `The ${what} path must be absolute (got "${input}"). This server's working directory is not ` +
        "the caller's, so a relative path would resolve somewhere unexpected.",
    );
  }
  const accepted = Object.keys(kinds).join(", ");
  if (!kinds[extname(path).toLowerCase()]) {
    throw new PreconditionError(
      `"${basename(path)}" does not look like a ${what}: accepted extensions are ${accepted}.`,
    );
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new PreconditionError(
      code === "ENOENT"
        ? `No such file: ${path}`
        : `Cannot read ${path}: ${(err as Error).message}`,
    );
  }
  // The target decides, not the link: `demo.mp4 -> ~/.ssh/id_ed25519` is not a video.
  const mimeType = kinds[extname(real).toLowerCase()];
  if (!mimeType) {
    throw new PreconditionError(
      `${path} is a link to "${basename(real)}", which does not look like a ${what}.`,
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new PreconditionError(`${path} is not a regular file.`);
  if (info.size === 0) throw new PreconditionError(`${path} is empty (0 bytes).`);
  if (info.size > maxBytes) {
    throw new PreconditionError(
      `${path} is ${info.size} bytes, over the ${what} limit of ${maxBytes} bytes.`,
    );
  }
  const head = new Uint8Array(16);
  const handle = await open(real, "r");
  try {
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  if (!looksLike(mimeType, head)) {
    throw new PreconditionError(
      `${path} has a ${extname(real)} extension but its contents are not a ${mimeType} file.`,
      { remedy: "Check the path points at the rendered file, not a project or a placeholder." },
    );
  }
  return {
    path,
    realPath: real,
    name: basename(path),
    size: info.size,
    mtimeMs: info.mtimeMs,
    mimeType,
  };
};

export const resolveVideoFile = (input: string): Promise<LocalFile> =>
  resolveFile(input, VIDEO_MIME_TYPES, "video file", MAX_VIDEO_BYTES);

/** Validate a thumbnail without reading it all, so a bad path fails before an upload starts. */
export const resolveImageFile = (input: string): Promise<LocalFile> =>
  resolveFile(input, IMAGE_MIME_TYPES, "thumbnail image", MAX_THUMBNAIL_BYTES);

export const readImageFile = async (input: string): Promise<LocalFile & { data: Uint8Array }> => {
  const file = await resolveImageFile(input);
  return { ...file, data: new Uint8Array(await readFile(file.realPath)) };
};
