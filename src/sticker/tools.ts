import { execFile } from "child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { botError } from "../log.ts";
import type { Media } from "../wa/media.ts";

export const SIZE = 512;
// Límites de WhatsApp por sticker: 500 KB animado, 100 KB estático y 10 s en total (margen para EXIF)
export const MAX_SECONDS = 9.5;
export const MAX_AUDIO_SECONDS = 10;
export const MAX_FPS = 15;
const EXIF_MARGIN = 1024;
const MAX_BYTES = { animated: 500 * 1024 - EXIF_MARGIN, still: 100 * 1024 - EXIF_MARGIN };
const PARALLEL = 4;

export type Ratio = [number, number];
export type AudioTrack = { data: Buffer; mimetype: "audio/ogg; codecs=opus"; seconds: number };
export type WebpInfo = {
  width: number;
  height: number;
  seconds: number;
  animated: boolean;
  hasAlpha: boolean;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  pix_fmt?: string;
  nb_frames?: string;
  duration?: string;
};
type ProbeOutput = { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
type MediaProbe = {
  width: number;
  height: number;
  fps: number;
  sar: number;
  animated: boolean;
  hasAlpha: boolean;
  hasAudio: boolean;
  audioCodec: string;
  duration: number;
};

const waiters: (() => void)[] = [];
let active = 0;

export function run(command: string, args: string[], timeout = 120_000) {
  return new Promise<string>((resolve, reject) => {
    const options = { timeout, maxBuffer: 50 * 1024 * 1024, windowsHide: true };
    execFile(command, args, options, (err, stdout, stderr) => {
      const tail = String(stderr).trim().split(/\r?\n/).slice(-3).join(" / ");
      const why = err?.killed ? `tardó más de ${timeout / 1000} s` : tail || err?.message;
      if (err) reject(Object.assign(err, { message: `${command} falló: ${why}` }));
      else resolve(stdout);
    });
  });
}

const ffmpeg = (args: string[]) =>
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export async function withTemp<T>(task: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "sticker-"));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function limited<T>(task: () => Promise<T>) {
  if (active < PARALLEL) active++;
  else await new Promise<void>((resolve) => waiters.push(resolve));
  try {
    return await task();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}

// ffprobe no informa la duración ni las dimensiones de un WebP animado de forma uniforme: se leen los chunks RIFF
export function webpInfo(data: Buffer): WebpInfo | null {
  if (
    data.length < 16 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  let width = 0;
  let height = 0;
  let ms = 0;
  let frames = 0;
  let hasAnimFlag = false;
  let hasAlpha = false;
  let at = 12;
  while (at + 8 <= data.length) {
    const tag = data.toString("ascii", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    const payload = at + 8;
    if (payload + size > data.length) break;
    if (tag === "VP8X" && size >= 10) {
      const flags = data[payload]!;
      hasAnimFlag = (flags & 0x02) !== 0;
      hasAlpha = (flags & 0x10) !== 0;
      width = data.readUIntLE(payload + 4, 3) + 1;
      height = data.readUIntLE(payload + 7, 3) + 1;
    } else if (tag === "VP8 " && size >= 10 && !width && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      width = data.readUInt16LE(payload + 6) & 0x3fff;
      height = data.readUInt16LE(payload + 8) & 0x3fff;
    } else if (tag === "VP8L" && size >= 5 && !width && data[payload] === 0x2f) {
      const bits = data.readUInt32LE(payload + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      hasAlpha = ((bits >> 28) & 1) !== 0;
    } else if (tag === "ANMF" && size >= 16) {
      frames++;
      ms += data.readUIntLE(payload + 12, 3);
    }
    at += 8 + size + (size % 2);
  }
  return {
    width,
    height,
    seconds: ms / 1000,
    animated: frames > 1 || (hasAnimFlag && ms > 0),
    hasAlpha,
  };
}

function parseFrac(raw: string | undefined, sep: string) {
  if (!raw) return 0;
  const [a, b] = raw.split(sep).map(Number);
  return a! > 0 && (b === undefined || b > 0) ? a! / (b ?? 1) : 0;
}

async function probeMedia(input: string, mimetype: string, webp: WebpInfo | null): Promise<MediaProbe> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio,pix_fmt,nb_frames,duration",
    "-of",
    "json",
    input,
  ];
  const parsed = JSON.parse(await run("ffprobe", args)) as ProbeOutput;
  const streams = parsed.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const width = webp?.width || Number(v?.width) || 0;
  const height = webp?.height || Number(v?.height) || 0;
  const fps = parseFrac(v?.avg_frame_rate, "/") || parseFrac(v?.r_frame_rate, "/");
  const sar = parseFrac(v?.sample_aspect_ratio, ":") || 1;
  const nbFrames = Number(v?.nb_frames) || 0;
  const duration =
    webp?.seconds ||
    Number(a?.duration) ||
    Number(v?.duration) ||
    Number(parsed.format?.duration) ||
    0;
  const mime = mimetype.toLowerCase();
  const isVideo = /^video\//.test(mime);
  const isGif = /^image\/gif/.test(mime) || v?.codec_name === "gif";
  const animated = webp
    ? webp.animated
    : isVideo || isGif
      ? nbFrames !== 1
      : nbFrames > 1;
  const hasAlpha = Boolean(
    webp?.hasAlpha || (v?.pix_fmt && /(?:rgba|bgra|argb|abgr|yuva|pal8|ya\d)/i.test(v.pix_fmt)),
  );
  return {
    width,
    height,
    fps,
    sar,
    animated,
    hasAlpha,
    hasAudio: Boolean(a),
    audioCodec: a?.codec_name ?? "",
    duration,
  };
}

// Con x:x se recorta lo visible, como en cualquier imagen con transparencia: las bandas de un
// sticker o de un PNG no cuentan. Con reset=0, cropdetect da el área mayor de todos los cuadros
async function visible(input: string) {
  const find = "format=rgba,alphaextract,cropdetect=skip=0:round=2:reset=0,metadata=print:file=-";
  const log = await ffmpeg(["-i", input, "-vf", find, "-f", "null", "-"]);
  const box: Record<string, number> = {};
  for (const [, key, value] of log.matchAll(/cropdetect\.(\w)=(-?\d+)/g)) box[key!] = Number(value);
  return box.w! > 0 && box.h! > 0 ? [`crop=${box.w}:${box.h}:${box.x}:${box.y}`] : [];
}

// Passthrough cuando el WebP ya cumple los límites; si hay que recodificar con libwebp, ajusta
// calidad, fps y lado de forma adaptativa para aprovechar el límite de 100/500 KB sin degradar
export async function toSticker(media: Media, ratio?: Ratio): Promise<Media> {
  const native = webpInfo(media.data);
  if (native && !ratio) {
    const limit = native.animated ? MAX_BYTES.animated : MAX_BYTES.still;
    const square = native.width > 0 && native.width === native.height && native.width <= SIZE;
    if (square && media.data.length <= limit && native.seconds <= MAX_SECONDS) {
      return { data: media.data, mimetype: "image/webp" };
    }
  }
  return limited(() =>
    withTemp(async (dir) => {
      const input = join(dir, "input");
      const output = join(dir, "sticker.webp");
      await writeFile(input, media.data);
      const info = await probeMedia(input, media.mimetype, native);
      const limit = info.animated ? MAX_BYTES.animated : MAX_BYTES.still;
      const [w, h] = ratio ?? [];
      const area = ratio && info.hasAlpha ? await visible(input) : [];
      const sarFix =
        Math.abs(info.sar - 1) > 0.01 ? [`scale=trunc(iw*${info.sar}/2)*2:ih`, "setsar=1"] : [];
      const crop = ratio ? [...sarFix, ...area, `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`] : sarFix;
      const squareOut = ratio ? w === h : !sarFix.length && info.width > 0 && info.width === info.height;
      const maxDim = Math.max(info.width, info.height) || SIZE;
      const startSide = info.animated && !ratio ? Math.min(SIZE, maxDim) : SIZE;
      const sourceFps = info.fps > 0 ? info.fps : 0;
      const startFps = info.animated
        ? sourceFps > 0 && sourceFps <= MAX_FPS
          ? Math.max(1, Math.round(sourceFps))
          : MAX_FPS
        : 0;
      const startQuality = info.animated ? 85 : 90;

      let side = startSide;
      let fps = startFps;
      let quality = startQuality;
      let best: Buffer | undefined;
      let polished = false;

      for (let attempt = 0; attempt < 6; attempt++) {
        const keepTiming = info.animated && sourceFps > 0 && fps >= sourceFps - 0.1;
        const timing = info.animated
          ? ["-t", String(MAX_SECONDS), ...(keepTiming ? ["-fps_mode", "passthrough"] : [])]
          : [];
        const fit = squareOut
          ? !ratio && !sarFix.length && info.width === side
            ? []
            : [`scale=${side}:${side}:flags=lanczos`, ...(info.hasAlpha ? ["format=rgba"] : [])]
          : [
              `scale=${side}:${side}:force_original_aspect_ratio=decrease:flags=lanczos`,
              "format=rgba",
              `pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
            ];
        const filters = [
          ...crop,
          ...(info.animated && !keepTiming ? [`fps=${fps}`] : []),
          ...fit,
        ];
        const encode = [
          "-c:v",
          "libwebp",
          "-q:v",
          String(quality),
          "-compression_level",
          "3",
          ...(info.animated ? ["-loop", "0"] : []),
        ];
        const vf = filters.length ? ["-vf", filters.join(",")] : [];
        await ffmpeg(["-i", input, "-an", ...timing, ...vf, ...encode, output]);
        const size = (await stat(output)).size;
        if (size <= limit) {
          best = await readFile(output);
          const lowered = quality < startQuality || side < startSide || fps < startFps;
          if (attempt < 5 && !polished && lowered && size < limit * 0.78 && quality < 85) {
            polished = true;
            quality = Math.min(88, quality + (size < limit * 0.65 ? 22 : 14));
            continue;
          }
          return { data: best, mimetype: "image/webp" };
        }
        if (best) return { data: best, mimetype: "image/webp" };

        const over = size / limit;
        if (!info.animated) {
          if (quality > 45) {
            quality = Math.max(45, Math.round(quality - (over - 1) * 45 - 8));
          } else {
            side = Math.max(96, Math.min(side - 32, Math.floor((side * (1 / over) ** 0.55 * 0.94) / 16) * 16));
          }
          continue;
        }

        if (over <= 1.28 && quality > 58) {
          quality = Math.max(58, Math.round(quality - (over - 1) * 75 - 6));
          continue;
        }
        const qFactor = quality >= 80 ? 0.82 : quality >= 68 ? 0.9 : 1;
        quality = quality > 65 ? 65 : Math.max(40, quality - 10);
        let need = 1 / Math.max(1.01, over * qFactor);
        if (fps > 10 && need < 0.85) {
          const nextFps = Math.max(10, Math.min(fps - 2, Math.round(fps * need ** 0.35)));
          need /= (nextFps / fps) ** 0.9;
          fps = nextFps;
        } else if (fps > 8 && side <= 224 && need < 0.88) {
          const nextFps = Math.max(8, fps - 2);
          need /= (nextFps / fps) ** 0.9;
          fps = nextFps;
        }
        if (need < 0.96) {
          side = Math.max(96, Math.min(side - 32, Math.floor((side * need ** 0.58 * 0.96) / 16) * 16));
        }
      }
      throw botError("sticker_size", `No cabe en ${limit / 1024} KB`);
    }),
  );
}

export async function toStickerAudio(media: Media, maxSeconds = MAX_AUDIO_SECONDS): Promise<AudioTrack | null> {
  return limited(() =>
    withTemp(async (dir) => {
      const input = join(dir, "input");
      const output = join(dir, "audio.ogg");
      await writeFile(input, media.data);
      const info = await probeMedia(input, media.mimetype, null);
      if (!info.hasAudio) return null;
      const cap = Math.min(maxSeconds, MAX_AUDIO_SECONDS);
      if (
        info.audioCodec === "opus" &&
        media.mimetype.toLowerCase().startsWith("audio/ogg") &&
        info.duration > 0 &&
        info.duration <= cap + 0.25
      ) {
        return {
          data: media.data,
          mimetype: "audio/ogg; codecs=opus",
          seconds: Math.max(1, Math.round(info.duration)),
        };
      }
      await ffmpeg([
        "-i",
        input,
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        String(cap),
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-ar",
        "48000",
        "-application",
        "audio",
        "-f",
        "ogg",
        output,
      ]);
      const outInfo = await probeMedia(output, "audio/ogg; codecs=opus", null);
      const secs = outInfo.duration || Math.min(info.duration || cap, cap);
      return {
        data: await readFile(output),
        mimetype: "audio/ogg; codecs=opus",
        seconds: Math.max(1, Math.round(secs)),
      };
    }),
  );
}
