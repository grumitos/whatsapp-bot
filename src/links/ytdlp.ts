import { SIZE, run } from "../sticker/tools.ts";
import { USER_AGENT } from "./guard.ts";

type Format = { url: string; vcodec?: string; width?: number; height?: number; tbr?: number };
export type Info = { _type?: string; entries?: Info[]; formats?: Format[] };

// El motivo es la última línea con "ERROR:" de la salida de yt-dlp, sin ese prefijo
export function ytDlpReason(err: Error) {
  const reason = err.message.split(" / ").findLast((l) => l.includes("ERROR:")) ?? err.message;
  return reason.replace(/^.*ERROR:\s*/, "").slice(0, 200);
}

export async function ytDlp(link: string) {
  const flags = ["--dump-single-json", "--no-playlist", "--no-warnings", "--ignore-config"];
  const args = [...flags, "--socket-timeout", "15", "--user-agent", USER_AGENT, link];
  const ytDlp = process.env.YT_DLP || "yt-dlp";
  return JSON.parse(await run(ytDlp, args, 60_000)) as Info;
}

// El formato con imagen más liviano que cubra el sticker o, si ninguno llega, el más grande
export function pickVideo(info: Info, accepts: (url: string) => boolean) {
  const post = info._type === "playlist" ? info.entries?.find(Boolean) : info;
  const side = (f: Format) => Math.max(f.width ?? 0, f.height ?? 0);
  const rate = (f: Format) => f.tbr ?? side(f);
  const pool = (post?.formats ?? []).filter((f) => f.vcodec !== "none" && accepts(f.url));
  if (!pool.length) return null;
  const fits = pool.filter((f) => side(f) >= SIZE);
  const score = (f: Format) => (fits.length ? -rate(f) : side(f) * 1e5 + rate(f));
  return (fits.length ? fits : pool).reduce((a, b) => (score(b) > score(a) ? b : a)).url;
}
