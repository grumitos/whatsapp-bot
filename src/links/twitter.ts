import { botError, log } from "../log.ts";
import { fetchJson } from "./guard.ts";
import type { LinkItem } from "./index.ts";
import { pickVideo, ytDlp, ytDlpReason } from "./ytdlp.ts";

export const TWITTER_HOSTS = ["x.com", "twitter.com"];
const EMBEDS = "cdn.syndication.twimg.com";
const POST_PATH = /^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/|$)/;
const NO_MEDIA = "El post de Twitter/X no tiene fotos, video ni GIF";
const LOGIN = "El post de Twitter/X requiere iniciar sesión";
const PHOTOS = ["pbs.twimg.com"];
const MP4 = /^https:\/\/video\.twimg\.com\/[^?]+\.mp4(\?|$)/;

type Photo = { type: string; media_url_https: string };
type Tweet = { mediaDetails?: Photo[]; quoted_tweet?: { mediaDetails?: Photo[] } };

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

function ytDlpError(err: Error) {
  const reason = ytDlpReason(err);
  if (/No video|not available|unavailable/i.test(reason)) return botError("x", NO_MEDIA);
  if (/requires authentication|not authorized|log ?in/i.test(reason)) return botError("x", LOGIN);
  return botError("x", `yt-dlp: ${reason}`, err);
}

export async function resolveTwitter(link: string): Promise<LinkItem[]> {
  const id = new URL(link).pathname.match(POST_PATH)?.[1] ?? "";
  const found = await photos(id).catch((err) => log.warn("Sin fotos del post de X", err));
  if (found?.length) return found.slice(0, 10);
  const info = await ytDlp(link).catch((err) => Promise.reject(ytDlpError(err)));
  const url = pickVideo(info, (url) => MP4.test(url));
  if (!url) throw botError("twitter", NO_MEDIA);
  return [{ url, hosts: ["video.twimg.com"] }];
}
