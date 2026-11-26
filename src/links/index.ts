import type { Media } from "../wa/media.ts";
import { guardedFetch, LINK_MEDIA_BYTES } from "./guard.ts";
import { INSTAGRAM_HOSTS, isInstagramPost, resolveInstagram } from "./instagram.ts";
import { TIKTOK_HOSTS, resolveTiktok } from "./tiktok.ts";
import { TWITTER_HOSTS, isTwitterPost, resolveTwitter } from "./twitter.ts";

// headers: lo que el CDN exige para entregar el archivo (cookies de la página, Referer)
type MediaKind = "audio" | "video";
export type MediaSource =
  | { url: string; hosts: string[]; headers?: Record<string, string> }
  | { load: (kind?: MediaKind) => Promise<Media> };
export type LinkItem = MediaSource & { audio?: MediaSource };
type Provider = { name: string; hosts: string[]; resolve: (link: string) => Promise<LinkItem[]> };
export type Link = { provider: Provider; url: string };

const PROVIDERS: (Provider & { accepts?: (url: URL) => boolean })[] = [
  { name: "TikTok", hosts: TIKTOK_HOSTS, resolve: resolveTiktok },
  { name: "Twitter/X", hosts: TWITTER_HOSTS, accepts: isTwitterPost, resolve: resolveTwitter },
  { name: "Instagram", hosts: INSTAGRAM_HOSTS, accepts: isInstagramPost, resolve: resolveInstagram },
];

export function findLink(text = ""): Link | null {
  for (const [match] of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = URL.parse(match.replace(/[).,;:!?'*_~\]…]+$/, ""));
    const host = (h: string) => url?.hostname === h || url?.hostname.endsWith(`.${h}`);
    const provider = PROVIDERS.find((p) => p.hosts.some(host) && (!p.accepts || p.accepts(url!)));
    if (url && provider) return { provider, url: url.href };
  }
  return null;
}

export async function linkMedia(item: MediaSource, kind?: MediaKind): Promise<Media> {
  if ("load" in item) return item.load(kind);
  const options = { maxBytes: LINK_MEDIA_BYTES, headers: item.headers };
  const { data, type } = await guardedFetch(item.url, item.hosts, options);
  return { data, mimetype: type.split(";")[0]!.trim() || "image/jpeg" };
}
