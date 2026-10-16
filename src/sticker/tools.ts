import { execFile } from "child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { botError } from "../log.ts";
import type { Media } from "../wa/media.ts";

export const SIZE = 512;
// Límites de WhatsApp por sticker: 500 KB animado, 100 KB estático y 10 s en total (con margen)
export const MAX_SECONDS = 9.5;
export type Ratio = [number, number];
const MAX_BYTES = { animated: 500 * 1024, still: 100 * 1024 };
const PARALLEL = 4;

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

// ffprobe no informa la duración de un WebP animado: se suma la de cada cuadro (ANMF)
function webpSeconds(data: Buffer) {
  let ms = 0;
  let at = 12;
  while (at + 8 <= data.length) {
    const size = data.readUInt32LE(at + 4);
    if (data.toString("ascii", at, at + 4) === "ANMF") ms += data.readUIntLE(at + 20, 3);
    at += 8 + size + (size % 2);
  }
  return ms / 1000;
}

// Si no cabe, baja primero la calidad y luego el tamaño; los fps nunca. Pasar de 75 a 45 quita
// un 22 % del peso (medido) y el resto lo cubre el lado: el peso crece con él elevado a ~1,5
export const toSticker = (media: Media, ratio?: Ratio) =>
  limited(() =>
    withTemp(async (dir) => {
      const input = join(dir, "input");
      const output = join(dir, "sticker.webp");
      await writeFile(input, media.data);
      const native = media.mimetype === "image/webp";
      const clip = /^video\/|^image\/gif/.test(media.mimetype);
      const seconds = native ? webpSeconds(media.data) : 0;
      const limit = clip || seconds > 0 ? MAX_BYTES.animated : MAX_BYTES.still;
      const probe = ["-show_entries", "stream=width,height", "-of", "csv=p=0", input];
      const sizes = native ? (await run("ffprobe", probe)).split(",").map(Number) : [];
      const small = media.data.length <= limit && Math.max(...sizes) <= SIZE;
      if (native && !ratio && small && seconds <= MAX_SECONDS) return media;
      const [w, h] = ratio ?? [];
      const crop = ratio ? [`crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`] : [];
      let side = native ? Math.min(SIZE, Math.max(...sizes)) : SIZE;
      let size = 0;
      for (const quality of [75, 45, 45, 45]) {
        const box = native ? `'min(${side},iw)':'min(${side},ih)'` : `${side}:${side}`;
        const pad = native ? "max(iw\\,ih)" : side;
        const scale = `scale=${box}:force_original_aspect_ratio=decrease:flags=lanczos`;
        const filters = [...crop, ...(clip ? ["fps=15"] : []), scale, "format=rgba"];
        filters.push(`pad=${pad}:${pad}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
        const encode = ["-c:v", "libwebp", "-q:v", String(quality), "-compression_level", "2"];
        const args = ["-t", String(MAX_SECONDS), "-vf", filters.join(","), ...encode];
        await ffmpeg(["-i", input, ...args, "-loop", "0", output]);
        size = (await stat(output)).size;
        if (size <= limit) break;
        const next = quality === 75 ? 0.78 : 1;
        side = Math.floor(side * Math.min(1, (limit / (size * next)) ** (2 / 3) * 0.9));
      }
      if (size > limit) throw botError("sticker_size", `No cabe en ${limit / 1024} KB`);
      return { data: await readFile(output), mimetype: "image/webp" };
    }),
  );
