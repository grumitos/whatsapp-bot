import { botError, log } from "../log.ts";
import { SIZE } from "../sticker/tools.ts";
import { fetchJson } from "./guard.ts";
import type { LinkItem } from "./index.ts";
import { pickVideos, ytDlp, ytDlpReason } from "./ytdlp.ts";

export const TWITTER_HOSTS = ["x.com", "twitter.com"];
const EMBEDS = "cdn.syndication.twimg.com";
const POST_PATH = /^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/|$)/;
const NO_MEDIA = "El post de Twitter/X no tiene fotos, video ni GIF";
const LOGIN = "El post de Twitter/X requiere iniciar sesión";
const PHOTOS = ["pbs.twimg.com"];
const VIDEOS = ["video.twimg.com"];
const MP4 = /^https:\/\/video\.twimg\.com\/[^?]+\.mp4(\?|$)/;

type Variant = { content_type?: string; bitrate?: number; url: string };
type MediaDetail = {
  type: string;
  media_url_https: string;
  original_info?: { width?: number; height?: number };
  video_info?: { variants?: Variant[] };
};
type Tweet = { mediaDetails?: MediaDetail[]; quoted_tweet?: { mediaDetails?: MediaDetail[] } };

export const isTwitterPost = (url: URL) => POST_PATH.test(url.pathname);

function pickMp4(item: MediaDetail): string | null {
  const pool = (item.video_info?.variants ?? []).filter(
    (v) => v.content_type === "video/mp4" && MP4.test(v.url),
  );
  if (!pool.length) return null;
  const side = (v: Variant) => {
    const dim = v.url.match(/\/(\d+)x(\d+)\//);
    return Math.max(
      Number(dim?.[1] ?? item.original_info?.width ?? 0),
      Number(dim?.[2] ?? item.original_info?.height ?? 0),
    );
  };
  const rate = (v: Variant) => v.bitrate ?? side(v);
  const fits = pool.filter((v) => side(v) >= SIZE);
  const score = (v: Variant) => (fits.length ? -rate(v) : side(v) * 1e9 + rate(v));
  return (fits.length ? fits : pool).reduce((a, b) => (score(b) > score(a) ? b : a)).url;
}

// Medios del post o, sin medios propios, los del citado (fotos, GIF y videos)
async function fromSyndication(id: string): Promise<LinkItem[]> {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const url = `https://${EMBEDS}/tweet-result?${new URLSearchParams({ id, token })}`;
  const tweet = await fetchJson<Tweet>(url, [EMBEDS], { "User-Agent": "Googlebot" });
  const media = tweet.mediaDetails?.length ? tweet.mediaDetails : tweet.quoted_tweet?.mediaDetails;
  return (media ?? []).flatMap((item): LinkItem[] => {
    if (item.type === "photo") return [{ url: `${item.media_url_https}?name=medium`, hosts: PHOTOS }];
    if (item.type === "animated_gif" || item.type === "video") {
      const mp4 = pickMp4(item);
      return mp4 ? [{ url: mp4, hosts: VIDEOS }] : [];
    }
    return [];
  });
}

function ytDlpError(err: Error) {
  const reason = ytDlpReason(err);
  if (/No video|not available|unavailable/i.test(reason)) return botError("x", NO_MEDIA);
  if (/requires authentication|not authorized|log ?in/i.test(reason)) return botError("x", LOGIN);
  return botError("x", `yt-dlp: ${reason}`, err);
}

export async function resolveTwitter(link: string): Promise<LinkItem[]> {
  const id = new URL(link).pathname.match(POST_PATH)?.[1] ?? "";
  const found = await fromSyndication(id).catch((err) => log.warn("Sin medios del post de X", err));
  if (found?.length) return found.slice(0, 10);
  const info = await ytDlp(link).catch((err) => Promise.reject(ytDlpError(err)));
  const urls = pickVideos(info, (url) => MP4.test(url));
  if (!urls.length) throw botError("twitter", NO_MEDIA);
  return urls.slice(0, 10).map((url) => ({ url, hosts: VIDEOS }));
}
