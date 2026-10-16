import { botError, log } from "../log.ts";
import { SIZE, run } from "../sticker/tools.ts";
import { USER_AGENT, fetchJson } from "./guard.ts";
import type { LinkItem } from "./index.ts";

export const TWITTER_HOSTS = ["x.com", "twitter.com"];
const EMBEDS = "cdn.syndication.twimg.com";
const POST_PATH = /^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/|$)/;
const NO_MEDIA = "El post de Twitter/X no tiene fotos, video ni GIF";
const LOGIN = "El post de Twitter/X requiere iniciar sesión";
const PHOTOS = ["pbs.twimg.com"];

type Photo = { type: string; media_url_https: string };
type Tweet = { mediaDetails?: Photo[]; quoted_tweet?: { mediaDetails?: Photo[] } };
type Format = { url: string; vcodec?: string; width?: number; height?: number; tbr?: number };
type Info = { _type?: string; entries?: Info[]; formats?: Format[] };

export const isTwitterPost = (url: URL) => POST_PATH.test(url.pathname);

// Fotos del post o, sin medios propios, las del citado (yt-dlp no las extrae); 1200 px bastan
async function photos(id: string): Promise<LinkItem[]> {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const url = `https://${EMBEDS}/tweet-result?${new URLSearchParams({ id, token })}`;
  const tweet = await fetchJson<Tweet>(url, [EMBEDS], { "User-Agent": "Googlebot" });
  const media = tweet.mediaDetails?.length ? tweet.mediaDetails : tweet.quoted_tweet?.mediaDetails;
  const found = (media ?? []).filter((item) => item.type === "photo");
  return found.map((item) => ({ url: `${item.media_url_https}?name=medium`, hosts: PHOTOS }));
}

function pickVideo(info: Info) {
  const post = info._type === "playlist" ? info.entries?.find(Boolean) : info;
  const side = (f: Format) => Math.max(f.width ?? 0, f.height ?? 0);
  const rate = (f: Format) => f.tbr ?? side(f);
  const mp4 = /^https:\/\/video\.twimg\.com\/[^?]+\.mp4(\?|$)/;
  const pool = (post?.formats ?? []).filter((f) => f.vcodec !== "none" && mp4.test(f.url));
  if (!pool.length) throw botError("twitter", NO_MEDIA);
  const fits = pool.filter((f) => side(f) >= SIZE);
  const score = (f: Format) => (fits.length ? -rate(f) : side(f) * 1e5 + rate(f));
  return (fits.length ? fits : pool).reduce((a, b) => (score(b) > score(a) ? b : a)).url;
}

function ytDlpError(err: Error) {
  const reason = err.message.split(" / ").findLast((l) => l.includes("ERROR:")) ?? err.message;
  if (/No video|not available|unavailable/i.test(reason)) return botError("x", NO_MEDIA);
  if (/requires authentication|not authorized|log ?in/i.test(reason)) return botError("x", LOGIN);
  return botError("x", `yt-dlp: ${reason.replace(/^.*ERROR:\s*/, "").slice(0, 200)}`, err);
}

export async function resolveTwitter(link: string): Promise<LinkItem[]> {
  const id = new URL(link).pathname.match(POST_PATH)?.[1] ?? "";
  const found = await photos(id).catch((err) => log.warn("Sin fotos del post de X", err));
  if (found?.length) return found.slice(0, 10);
  const flags = ["--dump-single-json", "--no-playlist", "--no-warnings", "--ignore-config"];
  const args = [...flags, "--socket-timeout", "15", "--user-agent", USER_AGENT, link];
  const ytDlp = process.env.YT_DLP || "yt-dlp";
  const output = await run(ytDlp, args, 60_000).catch((err) => Promise.reject(ytDlpError(err)));
  return [{ url: pickVideo(JSON.parse(output)), hosts: ["video.twimg.com"] }];
}
