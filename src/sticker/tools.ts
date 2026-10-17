import { execFile } from "child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Media } from "../wa/media.ts";

export const SIZE = 512;
export const MAX_SECONDS = 8;
export type Ratio = [number, number];
const MAX_BYTES = 500 * 1024;
const PARALLEL = 4;

// De mayor a menor calidad hasta que quepa; minRatio salta los intentos que no cabrían
const ATTEMPTS = [
  { fps: 15, quality: 60, minRatio: 1 },
  { fps: 12, quality: 35, minRatio: 0.46 },
  { fps: 10, quality: 30, minRatio: 0.35 },
  { fps: 8, quality: 25, minRatio: 0.25 },
  { fps: 6, quality: 20, minRatio: 0.17 },
  { fps: 5, quality: 10, minRatio: 0.11 },
];

// Un sticker animado ya viene a su medida: fps 0 conserva los del original y solo baja la calidad
const NATIVE = [
  { fps: 0, quality: 60, minRatio: 1 },
  { fps: 0, quality: 35, minRatio: 0.7 },
];

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

const isAnimated = ({ mimetype, data }: Media) =>
  /^video\/|^image\/gif/.test(mimetype) || (mimetype === "image/webp" && data.includes("ANIM"));

const isAnimatedWebp = (media: Media) => media.mimetype === "image/webp" && isAnimated(media);

const convert = (media: Media, ratio?: Ratio) =>
  limited(() =>
    withTemp(async (dir) => {
      const input = join(dir, "input");
      const output = join(dir, "sticker.webp");
      await writeFile(input, media.data);
      const [w, h] = ratio ?? [];
      const crop = ratio ? [`crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`] : [];
      const native = isAnimatedWebp(media);
      const box = native ? [`'min(${SIZE},iw)'`, `'min(${SIZE},ih)'`] : [SIZE, SIZE];
      const side = native ? "max(iw\\,ih)" : SIZE;
      const scale = `scale=${box.join(":")}:force_original_aspect_ratio=decrease:flags=lanczos`;
      const pad = `pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
      const rate = (fps: number) => (fps ? [`fps=${fps}`] : []);
      const filters = (fps = 0) => [...crop, ...rate(fps), scale, "format=rgba", pad].join(",");
      const attempts = native ? [...NATIVE, ...ATTEMPTS] : isAnimated(media) ? ATTEMPTS : [];
      if (!attempts.length) await ffmpeg(["-i", input, "-vf", filters(), output]);
      let first = 0;
      for (const [i, { fps, quality, minRatio }] of attempts.entries()) {
        if (first * minRatio > MAX_BYTES && i < attempts.length - 1) continue;
        const encode = ["-c:v", "libwebp", "-q:v", String(quality), "-compression_level", "2"];
        const args = ["-t", String(MAX_SECONDS), "-vf", filters(fps), ...encode];
        await ffmpeg(["-i", input, ...args, "-loop", "0", output]);
        const size = (await stat(output)).size;
        first ||= size;
        if (size <= MAX_BYTES) break;
      }
      return { data: await readFile(output), mimetype: "image/webp" };
    }),
  );

export const toSticker = async (media: Media, ratio?: Ratio) =>
  isAnimatedWebp(media) && !ratio ? media : convert(media, ratio);
