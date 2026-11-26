import { SIZE, run } from "../sticker/tools.ts";
import { USER_AGENT } from "./guard.ts";

export type Format = {
  url: string;
  protocol?: string;
  filesize?: number;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  tbr?: number;
};
export type Info = { _type?: string; entries?: Info[]; formats?: Format[] };

// El motivo es la última línea con "ERROR:" de la salida de yt-dlp, sin ese prefijo
export function ytDlpReason(err: Error) {
  const reason = err.message.split(" / ").findLast((l) => l.includes("ERROR:")) ?? err.message;
  return reason.replace(/^.*ERROR:\s*/, "").slice(0, 200);
}

export const runYtDlp = (args: string[], timeout = 60_000) =>
  run(process.env.YT_DLP || "yt-dlp", args, timeout);

export async function ytDlp(link: string, options: string[] = []) {
  const flags = ["--dump-single-json", "--no-playlist", "--no-warnings", "--ignore-config"];
  const args = [...flags, "--socket-timeout", "15", "--user-agent", USER_AGENT, ...options, link];
  return JSON.parse(await runYtDlp(args)) as Info;
}

// Por cada entrada del post elige el formato con imagen más liviano que cubra el sticker (priorizando
// pistas con audio); si ninguno llega a 512 px, elige el más grande
export function pickVideos(info: Info, accepts: (url: string) => boolean): string[] {
  const posts = info._type === "playlist" ? (info.entries ?? []).filter(Boolean) : [info];
  const side = (f: Format) => Math.max(f.width ?? 0, f.height ?? 0);
  const rate = (f: Format) => f.tbr ?? side(f);
  return posts.flatMap((post) => {
    const pool = (post.formats ?? []).filter((f) => f.vcodec !== "none" && accepts(f.url));
    if (!pool.length) return [];
    const withAudio = pool.filter((f) => f.acodec !== "none");
    const usable = withAudio.length ? withAudio : pool;
    const fits = usable.filter((f) => side(f) >= SIZE);
    const score = (f: Format) => (fits.length ? -rate(f) : side(f) * 1e5 + rate(f));
    return [(fits.length ? fits : usable).reduce((a, b) => (score(b) > score(a) ? b : a)).url];
  });
}
