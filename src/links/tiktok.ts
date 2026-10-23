import { botError, log } from "../log.ts";
import { fetchJson, guardedFetch } from "./guard.ts";
import type { LinkItem } from "./index.ts";

export const TIKTOK_HOSTS = ["tiktok.com"];
const MEDIA_HOSTS = ["tikwm.com", "tiktokcdn.com", "tiktokcdn-us.com", "ibyteimg.com"];
const POST_PATH = /^\/(?:@[^/]*\/(?:video|photo)\/(\d+)\/?|v\/(\d+)\.html)$/i;

// Como la app de Android: la web oculta los comentarios con adjuntos que no sabe mostrar
const APP = { aid: "1233", app_name: "musical_ly", device_platform: "android" };

type Sizes = Record<string, { url_list?: string[] } | undefined>;
type Img = Record<"origin_url" | "crop_url", { url_list?: string[] } | undefined>;
type Sticker = { animated_url?: Sizes; static_url?: Sizes };
type Attachments = { cmt_sticker_struct?: Sticker; image_list?: Img[] | null };
type Comment = Attachments & { cid: string; reply_comment?: Comment[] };
type Page = { status_code: number; comments?: Comment[]; has_more?: number; cursor?: number };
type Post = { images?: string[]; play?: string; hdplay?: string };
type Tikwm = { code: number; msg?: string; data?: Post };
type Photo = { imageURL?: { urlList?: string[] } };
type Web = { video?: { playAddr?: string }; imagePost?: { images?: Photo[] } };

// El video sale de *.tiktok.com y las fotos de tiktokcdn; tikwm no recibe estas cookies
const WEB_HOSTS = [...TIKTOK_HOSTS, ...MEDIA_HOSTS.filter((host) => host !== "tikwm.com")];

const items = (urls: (string | undefined)[]): LinkItem[] =>
  urls.flatMap((url) => (url ? [{ url, hosts: MEDIA_HOSTS }] : [])).slice(0, 10);

const best = (sizes?: Sizes) =>
  ["high", "mid", "low"]
    .map((size) => sizes?.[`${size}_resolution_url`]?.url_list?.[0])
    .find(Boolean);

const jpeg = (urls: string[]) => urls.find((url) => /\.jpe?g(\?|$)/i.test(url)) ?? urls[0];

// El post viene en un JSON de la página; el CDN pide sus cookies y el Referer de TikTok
function webItems(json: string | undefined, cookie: string): LinkItem[] {
  const detail = json ? JSON.parse(json).__DEFAULT_SCOPE__?.["webapp.video-detail"] : undefined;
  const post: Web | undefined = detail?.itemInfo?.itemStruct;
  const photos = (post?.imagePost?.images ?? []).map((i) => jpeg(i.imageURL?.urlList ?? []));
  const urls = photos.length ? photos : [post?.video?.playAddr];
  const headers = { Cookie: cookie, Referer: "https://www.tiktok.com/" };
  const media = urls.flatMap((url) => (url ? [{ url, hosts: WEB_HOSTS, headers }] : []));
  if (!media.length) {
    throw botError("tiktok", `La página no trae el post: ${detail?.statusCode ?? "sin datos"}`);
  }
  return media.slice(0, 10);
}

// Más rápido y estable que tikwm. La página /photo/ no trae el post; la /video/ con el mismo id, sí
async function fromWeb(url: URL) {
  const page = url.href.replace("/photo/", "/video/");
  const { data, headers } = await guardedFetch(page, TIKTOK_HOSTS, { timeout: 8000 });
  const html = data.toString("utf8");
  const found = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return webItems(found?.[1], cookie);
}

// Un comentario con sticker trae image_list: null, y el valor por defecto no cubre null
function commentMedia({ cmt_sticker_struct: sticker, image_list: images }: Attachments) {
  const photos = (images ?? []).map((image) => (image.origin_url ?? image.crop_url)?.url_list ?? []);
  return items([best(sticker?.animated_url) ?? best(sticker?.static_url), ...photos.map(jpeg)]);
}

// insert_ids pone el comentario primero; si TikTok dejara de respetarlo, se busca por páginas
async function findComment(aweme_id: string, commentId: string) {
  let cursor = 0;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ ...APP, version_name: "44.0.3", aweme_id, count: "50" });
    query.set(page ? "cursor" : "insert_ids", page ? String(cursor) : commentId);
    const url = `https://www.tiktok.com/api/comment/list/?${query}`;
    const data = await fetchJson<Page>(url, TIKTOK_HOSTS, { Referer: "https://www.tiktok.com/" });
    if (data.status_code !== 0) throw botError("tiktok", `API de comentarios: ${data.status_code}`);
    const all = (data.comments ?? []).flatMap((item) => [item, ...(item.reply_comment ?? [])]);
    const found = all.find((item) => item.cid === commentId);
    if (found || !data.has_more || data.cursor == null || data.cursor === cursor) return found;
    cursor = data.cursor;
  }
}

export async function resolveTiktok(link: string) {
  const isShort = (url: URL) => /^v[mt]\./.test(url.hostname) || url.pathname.startsWith("/t/");
  const { url } = await guardedFetch(link, TIKTOK_HOSTS, { stop: (url) => !isShort(url) });
  const commentId = url.searchParams.get("share_comment_id");
  const post = url.pathname.match(POST_PATH)?.slice(1).find(Boolean);
  if (commentId) {
    const comment = post && /^\d+$/.test(commentId) && (await findComment(post, commentId));
    const media = comment ? commentMedia(comment) : [];
    if (!media.length) throw botError("tiktok", "El comentario no existe o no tiene un adjunto");
    return media;
  }
  const found = await fromWeb(url).catch((err) => log.warn("TikTok: se usa tikwm", err));
  if (found) return found;
  const query = new URLSearchParams({ url: post ? url.origin + url.pathname : url.href, hd: "1" });
  const api = `https://www.tikwm.com/api/?${query}`;
  const payload = await fetchJson<Tikwm>(api, MEDIA_HOSTS);
  if (payload.code !== 0) throw botError("tiktok", `tikwm: ${payload.code} ${payload.msg}`);
  // En un post de fotos, play es la música; la calidad normal basta (el sticker mide 512 px)
  const { images = [], play, hdplay } = payload.data ?? {};
  const media = images.length ? items(images) : items([play ?? hdplay]);
  if (!media.length) throw botError("tiktok", "tikwm no devolvió el video");
  return media;
}
