import type { Media } from "../wa/media.ts";
import { guardedFetch } from "./guard.ts";
import { INSTAGRAM_HOSTS, isInstagramPost, resolveInstagram } from "./instagram.ts";
import { TIKTOK_HOSTS, resolveTiktok } from "./tiktok.ts";
import { TWITTER_HOSTS, isTwitterPost, resolveTwitter } from "./twitter.ts";

// headers: lo que el CDN exige para entregar el archivo (cookies de la página, Referer)
export type LinkItem = { url: string; hosts: string[]; headers?: Record<string, string> };
type Provider = { name: string; hosts: string[]; resolve: (link: string) => Promise<LinkItem[]> };
export type Link = { provider: Provider; url: string };

const PROVIDERS: (Provider & { accepts?: (url: URL) => boolean })[] = [
  { name: "TikTok", hosts: TIKTOK_HOSTS, resolve: resolveTiktok },
  { name: "Twitter/X", hosts: TWITTER_HOSTS, accepts: isTwitterPost, resolve: resolveTwitter },
  { name: "Instagram", hosts: INSTAGRAM_HOSTS, accepts: isInstagramPost, resolve: resolveInstagram },
];

const VIDEO_BYTES = 50 * 1024 * 1024;

export function findLink(text = ""): Link | null {
  for (const [match] of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = URL.parse(match.replace(/[).,;:!?'*_~\]…]+$/, ""));
    const host = (h: string) => url?.hostname === h || url?.hostname.endsWith(`.${h}`);
    const provider = PROVIDERS.find((p) => p.hosts.some(host) && (!p.accepts || p.accepts(url!)));
    if (url && provider) return { provider, url: url.href };
  }
  return null;
}

export async function linkMedia(item: LinkItem): Promise<Media> {
  const options = { maxBytes: VIDEO_BYTES, headers: item.headers };
  const { data, type } = await guardedFetch(item.url, item.hosts, options);
  return { data, mimetype: type.split(";")[0]!.trim() || "image/jpeg" };
}
