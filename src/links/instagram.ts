import { botError, log } from "../log.ts";
import { SIZE } from "../sticker/tools.ts";
import { guardedFetch } from "./guard.ts";
import type { LinkItem } from "./index.ts";
import { pickVideo, ytDlp, ytDlpReason } from "./ytdlp.ts";

export const INSTAGRAM_HOSTS = ["instagram.com"];
const MEDIA_HOSTS = ["cdninstagram.com", "fbcdn.net"];
const POST_PATH = /^\/(?:[^/]+\/)?(?:p|reels?|tv)\/([\w-]+)(?:\/|$)/;
const NO_MEDIA = "El post de Instagram no tiene fotos ni video";
const LOGIN = "El post de Instagram requiere iniciar sesión (o Instagram limitó las consultas)";
// Con el agente de un rastreador, el embed trae los datos del post sin pedir sesión
const CRAWLER = { "User-Agent": "facebookexternalhit/1.1" };

type Resource = { src: string; config_width: number };
type Node = { is_video?: boolean; video_url?: string; display_url?: string };
type Post = Node & {
  display_resources?: Resource[];
  edge_sidecar_to_children?: { edges: { node: Node & { display_resources?: Resource[] } }[] };
};

export const isInstagramPost = (url: URL) => POST_PATH.test(url.pathname);

const item = (url: string): LinkItem => ({ url, hosts: MEDIA_HOSTS });

// La foto más chica que cubra el sticker; el display_url es la original
function photo({ display_url, display_resources = [] }: Post) {
  const fits = display_resources.filter((r) => r.config_width >= SIZE);
  return fits.sort((a, b) => a.config_width - b.config_width)[0]?.src ?? display_url;
}

const media = (node: Post) => (node.is_video ? node.video_url : photo(node));

// Los carruseles y los videos vienen en contextJSON; una foto sola, solo en la etiqueta <img>
async function fromEmbed(code: string): Promise<LinkItem[]> {
  const url = `https://www.instagram.com/p/${code}/embed/captioned/`;
  const { data } = await guardedFetch(url, INSTAGRAM_HOSTS, { headers: CRAWLER, timeout: 15_000 });
  const html = data.toString("utf8");
  const context = html.match(/"contextJSON":("(?:[^"\\]|\\.)*")/)?.[1];
  const post: Post | undefined = context && JSON.parse(JSON.parse(context)).gql_data?.shortcode_media;
  if (post) {
    const children = post.edge_sidecar_to_children?.edges.map((e) => e.node) ?? [post];
    return children.map(media).filter((u) => u != null).map(item);
  }
  const img = html.match(/class="EmbeddedMediaImage"[^>]*?\ssrc="([^"]+)"/)?.[1];
  return img ? [item(img.replaceAll("&amp;", "&"))] : [];
}

const fromCdn = (link: string) => {
  const url = URL.parse(link);
  return url?.protocol === "https:" && MEDIA_HOSTS.some((h) => url.hostname.endsWith(`.${h}`));
};

function ytDlpError(err: Error) {
  const reason = ytDlpReason(err);
  if (/login|log in|rate-limit|not authorized|private/i.test(reason)) {
    return botError("instagram", LOGIN);
  }
  if (/No video|not available|unavailable/i.test(reason)) return botError("instagram", NO_MEDIA);
  return botError("instagram", `yt-dlp: ${reason}`, err);
}

export async function resolveInstagram(link: string): Promise<LinkItem[]> {
  const code = new URL(link).pathname.match(POST_PATH)?.[1] ?? "";
  const found = await fromEmbed(code).catch((err) => log.warn("Sin datos del embed de Instagram", err));
  if (found?.length) return found.slice(0, 10);
  const info = await ytDlp(link).catch((err) => Promise.reject(ytDlpError(err)));
  const url = pickVideo(info, fromCdn);
  if (!url) throw botError("instagram", NO_MEDIA);
  return [item(url)];
}
