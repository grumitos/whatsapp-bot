import { createDecipheriv, hkdfSync } from "crypto";
import pkg from "whatsapp-web.js";
import { botError } from "../log.ts";
import { page } from "./client.ts";

type Keys = { directPath?: string; mediaKey?: string };
export type StickerAudio = {
  directPath?: string | null;
  deprecatedMms3Url?: string | null;
  mediaKey?: string | null;
  mediaKeyTimestamp?: number;
  filehash?: string | null;
  encFilehash?: string | null;
  size?: number;
  duration?: number;
  mimetype?: string | null;
};
export type MediaData = Keys & {
  type: string;
  body?: string;
  mimetype?: string;
  stickerAudio?: StickerAudio | null;
};
export type Media = { data: Buffer; mimetype: string };

// Info de HKDF con la que WhatsApp deriva las claves de cada tipo (los GIF llegan como video)
const IMAGE = "WhatsApp Image Keys";
const AUDIO = "WhatsApp Audio Keys";
const INFO: Record<string, string> = {
  image: IMAGE,
  sticker: IMAGE,
  video: "WhatsApp Video Keys",
  audio: AUDIO,
  ptt: AUDIO,
};
const VISUAL = new Set(["image", "sticker", "video"]);

export const hasMedia = (data?: MediaData) =>
  Boolean(data?.directPath && data.mediaKey && VISUAL.has(data.type));

export const hasAudio = (data?: MediaData) =>
  Boolean(
    (data?.directPath && data.mediaKey && (data.type === "audio" || data.type === "ptt")) ||
      (data?.type === "sticker" && data.stickerAudio?.directPath && data.stickerAudio.mediaKey),
  );

// Se descarga y descifra aparte: msg.downloadMedia() falla con los ids @lid
export async function download(data: MediaData): Promise<Media> {
  const info = INFO[data.type];
  if (!info || !data.directPath || !data.mediaKey) {
    throw botError("media_download", `Medio no descargable (${data.type})`);
  }
  const url = `https://mmg.whatsapp.net${data.directPath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if ([403, 404, 410].includes(res.status)) throw botError("media_expired", `HTTP ${res.status}`);
  if (!res.ok) throw botError("media_http", `HTTP ${res.status}`);
  const file = Buffer.from(await res.arrayBuffer());
  // IV (16 bytes), clave AES (32), clave del MAC y referencia; los últimos 10 bytes son el MAC
  const mediaKey = Buffer.from(data.mediaKey, "base64");
  const keys = Buffer.from(hkdfSync("sha256", mediaKey, "", info, 112));
  const decipher = createDecipheriv("aes-256-cbc", keys.subarray(16, 48), keys.subarray(0, 16));
  const decrypted = Buffer.concat([decipher.update(file.subarray(0, -10)), decipher.final()]);
  return { data: decrypted, mimetype: data.mimetype ?? "application/octet-stream" };
}

export function downloadAudio(data: MediaData): Promise<Media> {
  if (data.type === "sticker" && data.stickerAudio?.directPath && data.stickerAudio.mediaKey) {
    return download({
      type: "audio",
      directPath: data.stickerAudio.directPath,
      mediaKey: data.stickerAudio.mediaKey,
      mimetype: data.stickerAudio.mimetype ?? "audio/ogg; codecs=opus",
    });
  }
  return download(data);
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export function imageType(data?: MediaData) {
  const mime = data?.mimetype ?? "";
  const type = mime.toLowerCase().split(";")[0]!.trim();
  const image = data?.type === "image" || data?.type === "sticker";
  return (hasMedia(data) && image && IMAGE_TYPES.find((known) => known === type)) || null;
}

export const toWhatsApp = (media: Media) =>
  new pkg.MessageMedia(media.mimetype, media.data.toString("base64"));

function prepareSend(media: boolean) {
  const key = window.require("WAWebMsgKey");
  // whatsapp-web.js busca el mensaje recién creado por _serialized.
  if (key?.prototype && !("_serialized" in key.prototype)) {
    Object.defineProperty(key.prototype, "_serialized", {
      configurable: true,
      get(this: { $1?: string }) { return this.$1; },
    });
  }
  if (!media) return;
  // Un __x_id nulo en los medios sobrescribe la clave del mensaje.
  const api = window.WWebJS;
  const original = api.processMediaData;
  if (!original || "hidesId" in original) return;
  const patched = async (...args: unknown[]) => {
    const media = await original(...args);
    if ("__x_id" in media) Object.defineProperty(media, "__x_id", { enumerable: false });
    return media;
  };
  Object.assign(api, { processMediaData: Object.assign(patched, { hidesId: true }) });
}

export const prepareMessage = (media: boolean) => page().evaluate(prepareSend, media);
