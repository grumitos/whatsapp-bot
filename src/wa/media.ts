import { createDecipheriv, hkdfSync } from "crypto";
import pkg from "whatsapp-web.js";
import { botError } from "../log.ts";
import { page } from "./client.ts";

type Keys = { directPath?: string; mediaKey?: string };
export type MediaData = Keys & { type: string; body?: string; mimetype?: string };
export type Media = { data: Buffer; mimetype: string };

// Info de HKDF con la que WhatsApp deriva las claves de cada tipo (los GIF llegan como video)
const IMAGE = "WhatsApp Image Keys";
const INFO: Record<string, string> = { image: IMAGE, sticker: IMAGE, video: "WhatsApp Video Keys" };

export const hasMedia = (data?: MediaData) =>
  Boolean(data?.directPath && data.mediaKey && INFO[data.type]);

// Se descarga y descifra aparte: msg.downloadMedia() falla con los ids @lid
export async function download(data: MediaData): Promise<Media> {
  const url = `https://mmg.whatsapp.net${data.directPath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if ([403, 404, 410].includes(res.status)) throw botError("media_expired", `HTTP ${res.status}`);
  if (!res.ok) throw botError("media_download", `HTTP ${res.status}`);
  const file = Buffer.from(await res.arrayBuffer());
  // IV (16 bytes), clave AES (32), clave del MAC y referencia; los últimos 10 bytes son el MAC
  const mediaKey = Buffer.from(data.mediaKey!, "base64");
  const keys = Buffer.from(hkdfSync("sha256", mediaKey, "", INFO[data.type]!, 112));
  const decipher = createDecipheriv("aes-256-cbc", keys.subarray(16, 48), keys.subarray(0, 16));
  const decrypted = Buffer.concat([decipher.update(file.subarray(0, -10)), decipher.final()]);
  return { data: decrypted, mimetype: data.mimetype ?? "application/octet-stream" };
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

// Los audios traen un __x_id nulo que la librería copia y que rompe el envío: se oculta
function hideId() {
  const api = window.WWebJS;
  const original = api.processMediaData;
  if ("hidesId" in original) return;
  const patched = async (...args: unknown[]) => {
    const media = await original(...args);
    if ("__x_id" in media) Object.defineProperty(media, "__x_id", { enumerable: false });
    return media;
  };
  Object.assign(api, { processMediaData: Object.assign(patched, { hidesId: true }) });
}

export const hideAudioId = () => page().evaluate(hideId);
