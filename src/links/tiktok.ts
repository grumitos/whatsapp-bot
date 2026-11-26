import { readdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { botError, log } from "../log.ts";
import { withTemp } from "../sticker/tools.ts";
import { allowed, fetchJson, guardedFetch, LINK_MEDIA_BYTES } from "./guard.ts";
import type { LinkItem } from "./index.ts";
import { runYtDlp, ytDlp, type Format, type Info } from "./ytdlp.ts";

export const TIKTOK_HOSTS = ["tiktok.com"];
const MEDIA_HOSTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "ibyteimg.com",
  "tiktokv.com",
  "muscdn.com",
];
const POST_PATH = /^\/(?:@[^/]*\/(?:video|photo)\/(\d+)\/?|v\/(\d+)\.html)$/i;
const DLP_ARGS = ["--no-cache-dir", "--force-ipv4", "--use-extractors", "TikTok,TikTokVM"];

// Como la app de Android: la web oculta los comentarios con adjuntos que no sabe mostrar
const APP = { aid: "1233", app_name: "musical_ly", device_platform: "android" };

type Sizes = Record<string, { url_list?: string[] } | undefined>;
type Img = Record<"origin_url" | "crop_url", { url_list?: string[] } | undefined>;
type Sticker = { animated_url?: Sizes; static_url?: Sizes };
type Attachments = { cmt_sticker_struct?: Sticker; image_list?: Img[] | null };
type Comment = Attachments & { cid: string; reply_comment?: Comment[] };
type Page = { status_code: number; comments?: Comment[]; has_more?: number; cursor?: number };
type Photo = { imageURL?: { urlList?: string[] } };
type Web = {
  video?: { playAddr?: string };
  imagePost?: { images?: Photo[] };
  music?: { playUrl?: string };
};

const WEB_HOSTS = [...TIKTOK_HOSTS, ...MEDIA_HOSTS];

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
  const musicUrl = photos.length ? post?.music?.playUrl : undefined;
  const audio = musicUrl ? { url: musicUrl, hosts: WEB_HOSTS, headers } : undefined;
  const media = urls.flatMap((url) => (url ? [{ url, hosts: WEB_HOSTS, headers, audio }] : []));
  if (!media.length) {
    throw botError("tiktok", `La página no trae el post: ${detail?.statusCode ?? "sin datos"}`);
  }
  return media.slice(0, 10);
}

// La página /photo/ no trae el post; la /video/ con el mismo id, sí
async function fromWeb(url: URL) {
  const page = url.href.replace("/photo/", "/video/");
  const { data, headers } = await guardedFetch(page, TIKTOK_HOSTS, { timeout: 8000 });
  const html = data.toString("utf8");
  const found = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return webItems(found?.[1], cookie);
}

async function downloadFormat(info: Info, format: Format) {
  const tooLarge = () => botError("link_size", "The TikTok source exceeds 50 MB.");
  if ((format.filesize ?? 0) > LINK_MEDIA_BYTES) throw tooLarge();
  return withTemp(async (dir) => {
    const source = join(dir, "info.json");
    // yt-dlp conserva las cookies y cabeceras de la extracción para la descarga.
    await writeFile(source, JSON.stringify({ ...info, formats: [format] }), { mode: 0o600 });
    await runYtDlp([
      "--ignore-config", "--quiet", "--no-warnings", "--no-playlist", "--socket-timeout", "15",
      ...DLP_ARGS, "--load-info-json", source, "-f", "best*",
      "--max-filesize", String(LINK_MEDIA_BYTES), "-o", join(dir, "media.%(ext)s"),
    ]).catch(() => { throw botError("clip_failed", "yt-dlp could not download the TikTok media."); });
    const file = (await readdir(dir)).find((name) => /^media\.(?!(?:part|ytdl)$)[a-z0-9]+$/i.test(name));
    if (!file) throw botError("clip_failed", "yt-dlp did not return the TikTok media.");
    const path = join(dir, file);
    if ((await stat(path)).size > LINK_MEDIA_BYTES) throw tooLarge();
    const ext = file.slice("media.".length);
    const mimetype = format.vcodec !== "none" ? `video/${ext}`
      : ext === "mp3" ? "audio/mpeg" : ext === "m4a" ? "audio/mp4" : `audio/${ext}`;
    return { data: await readFile(path), mimetype };
  });
}

async function fromYtDlp(url: URL): Promise<LinkItem[]> {
  const info = await ytDlp(url.href.replace("/photo/", "/video/"), DLP_ARGS)
    .catch(() => { throw botError("clip_failed", "yt-dlp could not resolve the TikTok post."); });
  const formats = (info.formats ?? []).filter((format) => {
    const media = URL.parse(format.url);
    return format.protocol === "https" && media && allowed(media, WEB_HOSTS);
  });
  const videos = formats.filter(({ vcodec }) => vcodec && vcodec !== "none");
  const video = videos.findLast(({ acodec }) => acodec && acodec !== "none") ?? videos.at(-1);
  const audio = formats.findLast(({ vcodec, acodec }) => vcodec === "none" && acodec && acodec !== "none");
  if (!video && !audio) throw botError("tiktok", "TikTok did not return media.");
  return [{ load: (kind) => downloadFormat(info, (kind === "audio" ? audio ?? video : video ?? audio)!) }];
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
  const found = await fromWeb(url).catch((err) => log.warn("TikTok web could not resolve the post; using yt-dlp", err));
  return found ?? fromYtDlp(url);
}
