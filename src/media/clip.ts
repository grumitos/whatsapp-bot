import { accessSync, constants } from "fs";
import { readdir, readFile, stat, writeFile, copyFile, chmod } from "fs/promises";
import { join } from "path";
import { botError, log } from "../log.ts";
import { run, withTemp } from "../sticker/tools.ts";
import type { Media } from "../wa/media.ts";

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 180;
export const MAX_CLIP_SECONDS = 60;
export const MAX_AUDIO_SECONDS = 600;

export type Range = { start: number; end: number };
export const rangeLength = ({ start, end }: Range) => Math.round((end - start) * 1000) / 1000;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIME = String.raw`\d{1,3}(?::\d{1,2}){0,2}(?:\.\d{1,3})?`;
const RANGE = new RegExp(`(?<!\\d)(${TIME})\\s*-\\s*(${TIME})(?!\\d)`);

const seconds = (value: string) => {
  const parts = value.split(":");
  const secs = Number(parts.pop());
  if (!Number.isFinite(secs) || secs < 0) return null;
  if (!parts.length) return secs;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  if (parts.length === 1) {
    const minutes = Number(parts[0]);
    return secs < 60 ? minutes * 60 + secs : null;
  }
  const [hours, minutes] = parts.map(Number);
  return minutes! < 60 && secs < 60 ? hours! * 3600 + minutes! * 60 + secs : null;
};

export function parseRange(text: string): Range | null {
  const clean = text.replace(/https?:\/\/\S+/gi, " ");
  const match = clean.match(RANGE);
  if (!match) return null;
  const start = seconds(match[1]!);
  const end = seconds(match[2]!);
  return start === null || end === null || end <= start ? null : { start, end };
}

function youtubeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "youtube.com" && host !== "youtu.be" && !host.endsWith(".youtube.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let id = "";
  if (host === "youtu.be") id = parts[0] ?? "";
  else if (parts[0] === "watch") id = url.searchParams.get("v") ?? "";
  else if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") id = parts[1] ?? "";
  return YOUTUBE_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function findYoutube(text: string) {
  for (const [raw] of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const found = youtubeUrl(raw.replace(/[).,;!?'"…]+$/, ""));
    if (found) return found;
  }
  return null;
}

const ytdlp = () => {
  const python = process.env.YTDLP_PYTHON;
  return python
    ? { command: python, prefix: ["-m", "yt_dlp"] }
    : { command: process.env.YT_DLP || "yt-dlp", prefix: [] };
};

function cookiesFile() {
  const path = process.env.YTDLP_COOKIES_FILE;
  if (!path) return null;
  try {
    accessSync(path, constants.R_OK);
    return path;
  } catch {
    log.once("yt-cookies", "Las cookies de YouTube no son legibles.");
    return null;
  }
}

function commonArgs(cookies: string | null) {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--quiet",
    "--no-warnings",
    "--no-progress",
    "--no-check-formats",
    "--socket-timeout",
    "15",
    "--retries",
    "2",
    // YouTube bloquea las peticiones autenticadas por IPv6 desde el sandbox.
    "--force-ipv4",
  ];
  if (cookies) {
    const deno = process.env.YTDLP_DENO;
    if (deno) args.push("--js-runtimes", `deno:${deno}`);
    args.push("--extractor-args", "youtube:player_client=web_safari,web_embedded,mweb");
  } else {
    args.push("--no-js-runtimes", "--extractor-args", "youtube:player_client=visionos");
  }
  return args;
}

async function ytdlpRun(args: string[], timeout = 240_000) {
  const { command, prefix } = ytdlp();
  const cookies = cookiesFile();
  const base = commonArgs(cookies);
  const execute = (extra: string[] = []) => run(command, [...prefix, ...extra, ...base, ...args], timeout);
  try {
    if (!cookies) return await execute();
    return await withTemp(async (dir) => {
      const copy = join(dir, "cookies.txt");
      await copyFile(cookies, copy);
      await chmod(copy, 0o600);
      return execute(["--cookies", copy]);
    });
  } catch (err) {
    const text = String((err as Error).message).toLowerCase();
    if (/live|premiere/.test(text)) throw botError("clip_live", "Cannot clip live streams.", err);
    if (/403|forbidden|no video formats|unable to download api|sign in|bot|cookie/.test(text)) {
      throw botError("clip_failed", "YouTube requested cookies.", err);
    }
    if (/requested format is not available/.test(text)) {
      throw botError("clip_failed", "YouTube did not provide that format.", err);
    }
    throw botError("clip_failed", "Could not download the file.", err);
  }
}

const clock = (total: number) => {
  const value = Math.max(0, total);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value - hours * 3600 - minutes * 60;
  const text = secs.toFixed(3).replace(/\.?0+$/, "").padStart(2, "0");
  return `${hours}:${String(minutes).padStart(2, "0")}:${text}`;
};

async function findOutput(dir: string, kind: "audio" | "video") {
  let found: string | null = null;
  let size = 0;
  for (const name of await readdir(dir)) {
    if (!name.startsWith("clip.") || name.endsWith(".part") || name.endsWith(".ytdl")) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isFile() && info.size > size) {
      found = path;
      size = info.size;
    }
  }
  if (!found) throw botError("clip_failed", `Could not download the ${kind}.`);
  return found;
}

type Stream = {
  index: number;
  codec_type: string;
  codec_name: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
};
type VideoStream = Stream & { width: number; height: number };

async function probe(file: string) {
  try {
    const out = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,pix_fmt,width,height:stream_disposition=attached_pic:format=duration,format_name:format_tags=major_brand",
        "-of",
        "json",
        file,
      ],
      30_000,
    );
    const data = JSON.parse(out) as {
      streams?: Stream[];
      format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } };
    };
    const video = data.streams?.find(
      (stream): stream is VideoStream =>
        stream.codec_type === "video" &&
        Boolean(stream.width && stream.height) &&
        !stream.disposition?.attached_pic,
    );
    const audio = data.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(data.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return { video, audio, duration, format: data.format?.format_name, brand: data.format?.tags?.major_brand };
  } catch (err) {
    const failure = err as { code?: unknown; killed?: unknown };
    if (failure.code === "ENOENT" || failure.killed) throw err;
    return null;
  }
}

async function encodeVideo(
  input: string,
  output: string,
  start: number,
  length: number,
  height: number,
  crf: number,
  video: VideoStream,
  audio?: Stream,
) {
  const sourceShort = Math.min(video.width, video.height);
  const target = Math.max(2, Math.floor(Math.min(height, sourceShort) / 2) * 2);
  const scale = video.width < video.height ? `scale=${target}:-2` : `scale=-2:${target}`;
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      String(start),
      "-i",
      input,
      "-t",
      String(length),
      "-map",
      `0:${video.index}`,
      ...(audio ? ["-map", `0:${audio.index}`] : []),
      "-vf",
      scale,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      output,
    ],
    180_000,
  );
}

async function encodeAudio(input: string, output: string, start: number, length: number, audio: Stream, bitrate: string) {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      String(start),
      "-i",
      input,
      "-t",
      String(length),
      "-map",
      `0:${audio.index}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      bitrate,
      "-ar",
      "44100",
      output,
    ],
    180_000,
  );
}

export async function toVideo(media: Media, range?: Range | null): Promise<Media> {
  return withTemp(async (dir) => {
    const input = join(dir, "input");
    await writeFile(input, media.data);
    return videoFile(input, join(dir, "out.mp4"), range);
  });
}

async function videoFile(input: string, output: string, range?: Range | null, clippedSeconds?: number): Promise<Media> {
  const info = await probe(input);
  if (!info?.video) throw botError("clip_no_video", "That link has no video.");
  const { video, audio, duration, format, brand } = info;
  const start = range?.start ?? 0;
  const end = range ? Math.min(range.end, duration) : duration;
  if (end <= start) throw botError("clip_range", "The range exceeds the video.");
  const length = end - start;
  const isClip = Boolean(range) || clippedSeconds !== undefined;
  const maxSeconds = clippedSeconds !== undefined ? clippedSeconds + 1 : isClip ? MAX_CLIP_SECONDS : MAX_VIDEO_SECONDS;
  if ((range ? rangeLength(range) : duration) > maxSeconds) {
    throw botError("clip_long", isClip ? "Maximum 60 s." : "Maximum 3 min; use !clip.");
  }
  const target = isClip || duration <= MAX_CLIP_SECONDS ? 720 : 480;
  if (
    !range &&
    video.codec_name === "h264" &&
    (video.pix_fmt === "yuv420p" || video.pix_fmt === "yuvj420p") &&
    (!audio || audio.codec_name === "aac") &&
    format?.split(",").includes("mp4") &&
    brand?.trim() !== "qt" &&
    Math.min(video.width, video.height) <= target &&
    (await stat(input)).size <= MAX_MEDIA_BYTES
  ) return { data: await readFile(input), mimetype: "video/mp4" };
  await encodeVideo(input, output, start, length, target, target >= 720 ? 28 : 30, video, audio);
  if ((await stat(output)).size > MAX_MEDIA_BYTES) {
    await encodeVideo(input, output, start, length, target >= 720 ? 480 : 360, 34, video, audio);
    if ((await stat(output)).size > MAX_MEDIA_BYTES) {
      throw botError("clip_large", "The file exceeds 15 MB.");
    }
  }
  return { data: await readFile(output), mimetype: "video/mp4" };
}

export async function toAudio(media: Media, range?: Range | null): Promise<Media> {
  return withTemp(async (dir) => {
    const input = join(dir, "input");
    await writeFile(input, media.data);
    const info = await probe(input);
    if (!info?.audio) throw botError("clip_no_audio", "That link has no audio.");
    const { duration, audio } = info;
    const start = range ? range.start : 0;
    const end = range ? Math.min(range.end, duration) : duration;
    if (end <= start) throw botError("clip_range", "The range exceeds the audio.");
    const length = end - start;
    if (range ? rangeLength(range) > MAX_AUDIO_SECONDS : length > MAX_AUDIO_SECONDS) {
      throw botError("clip_long", "Maximum 10 min.");
    }
    if (!range && info.format === "mp3" && audio.codec_name === "mp3" && media.data.length <= MAX_MEDIA_BYTES) {
      return { data: media.data, mimetype: "audio/mpeg" };
    }
    const output = join(dir, "out.mp3");
    await encodeAudio(input, output, start, length, audio, "128k");
    if ((await stat(output)).size > MAX_MEDIA_BYTES) {
      await encodeAudio(input, output, start, length, audio, "96k");
      if ((await stat(output)).size > MAX_MEDIA_BYTES) {
        throw botError("clip_large", "The file exceeds 15 MB.");
      }
    }
    return { data: await readFile(output), mimetype: "audio/mpeg" };
  });
}

async function youtubeInfo(url: string, dir: string) {
  const file = join(dir, "info.json");
  const json = await ytdlpRun(["--dump-single-json", url], 60_000);
  await writeFile(file, json);
  const data = JSON.parse(json) as { duration?: unknown; width?: unknown; height?: unknown };
  const value = (input: unknown) => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return { file, duration: value(data.duration), width: value(data.width), height: value(data.height) };
}

const downloadArgs = (dir: string) => [
  "--concurrent-fragments",
  "4",
  "-o",
  join(dir, "clip.%(ext)s"),
];

export async function youtubeVideo(url: string, range?: Range | null): Promise<Media> {
  const length = range ? rangeLength(range) : undefined;
  if (length !== undefined && length > MAX_CLIP_SECONDS) throw botError("clip_long", "Maximum 60 s.");
  return withTemp(async (dir) => {
    const outputArgs = ["--merge-output-format", "mp4", ...downloadArgs(dir)];
    if (range) {
      await ytdlpRun([
        "-S",
        "proto:m3u8",
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/best",
        ...outputArgs,
        "--download-sections",
        `*${clock(range.start)}-${clock(range.end)}`,
        "--force-keyframes-at-cuts",
        "--downloader-args",
        "ffmpeg_o:-preset veryfast",
        url,
      ]);
    } else {
      const info = await youtubeInfo(url, dir);
      if (info.duration && info.duration > MAX_VIDEO_SECONDS) {
        throw botError("clip_long", "Maximum 3 min; use !clip.");
      }
      const maxHeight = info.duration && info.duration <= MAX_CLIP_SECONDS ? 720 : 480;
      const portrait = Boolean(info.width && info.height && info.height > info.width);
      const filter = `${portrait ? "width" : "height"}<=${maxHeight}`;
      const format = `bv*[${filter}]+ba/b[${filter}]/best`;
      await ytdlpRun(["--load-info-json", info.file, "-f", format, ...outputArgs]);
    }
    return videoFile(await findOutput(dir, "video"), join(dir, "out.mp4"), null, length);
  });
}

export async function youtubeAudio(url: string, range?: Range | null): Promise<Media> {
  const audio = ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "128K"];
  if (range && rangeLength(range) > MAX_AUDIO_SECONDS) {
    throw botError("clip_long", "Maximum 10 min.");
  }
  return withTemp(async (dir) => {
    const info = range ? null : await youtubeInfo(url, dir);
    if (info?.duration && info.duration > MAX_AUDIO_SECONDS) throw botError("clip_long", "Maximum 10 min.");
    const source = range
      ? ["--download-sections", `*${clock(range.start)}-${clock(range.end)}`, url]
      : ["--load-info-json", info!.file];
    await ytdlpRun([...audio, ...downloadArgs(dir), ...source]);
    const file = await findOutput(dir, "audio");
    if (info && !info.duration) {
      const output = await probe(file);
      if (!output?.audio) throw botError("clip_no_audio", "That link has no audio.");
      if (output.duration > MAX_AUDIO_SECONDS) throw botError("clip_long", "Maximum 10 min.");
    }
    const data = await readFile(file);
    if (data.length > MAX_MEDIA_BYTES) throw botError("clip_large", "The file exceeds 15 MB.");
    return { data, mimetype: "audio/mpeg" };
  });
}
