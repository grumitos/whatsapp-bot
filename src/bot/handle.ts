import type { Message } from "whatsapp-web.js";
import { maybeFollowUp, withNames } from "../ai/followup.ts";
import { record } from "../ai/store.ts";
import { join } from "path";
import { DATA_DIR, config } from "../config.ts";
import { log } from "../log.ts";
import { readJson, writeJson } from "../store.ts";
import { client, page, type Loose } from "../wa/client.ts";
import { chatOf, messageId, namesOf, rawOf, senderOf, type Raw } from "../wa/identity.ts";
import { hasMedia, type MediaData } from "../wa/media.ts";
import { isEcho } from "../wa/send.ts";
import { mayUse } from "./access.ts";
import { ACTIONS, requestAlbum, requestOf, type Request } from "./actions.ts";
import { route } from "./route.ts";

export type Album = { at: number; items: MediaData[]; request: Request | null };
const ALBUM_MS = 24 * 3_600_000;
const albums = new Map<string, Album>();
const SEEN = join(DATA_DIR, "seen.json");
const RECENT_MS = 5 * 60_000;
const handled = new Set<string>();
let seenAt = readJson(SEEN, { at: 0 }).at;

// Las fotos de un envío múltiple llegan sueltas, enlazadas a un mensaje "album" sin imagen
export function getAlbum(id: string) {
  for (const [key, album] of albums) if (Date.now() - album.at > ALBUM_MS) albums.delete(key);
  const album = albums.get(id) ?? { at: Date.now(), items: [], request: null };
  albums.set(id, album);
  return album;
}

// message_create también trae lo que envía el propio número: así el dueño usa el bot desde él
export async function handle(msg: Message) {
  const raw = rawOf(msg) as Raw & { parentMsgKey?: string | { id: string } };
  const at = (raw.t ?? 0) * 1000;
  // Un mensaje puede llegar dos veces (el evento y la recuperación tras reiniciar)
  if (at < Date.now() - RECENT_MS || handled.has(messageId(raw.id))) return;
  if (handled.size > 5000) handled.clear();
  handled.add(messageId(raw.id));
  if (at > seenAt) writeJson(SEEN, { at: (seenAt = at) });
  const chatId = chatOf(raw);
  if (/@(broadcast|newsletter)$/.test(chatId) || isEcho(raw, msg.body)) return;
  const sender = await senderOf(raw);
  if (!mayUse(chatId, sender)) return;
  const key = raw.parentMsgKey;
  const albumId = hasMedia(raw) && (typeof key === "string" ? key.split("_")[2] : key?.id);
  const album = albumId ? getAlbum(albumId) : undefined;
  album?.items.push(raw);
  if (album?.request) await requestAlbum(album, album.request, [raw]);
  const found = await route(msg, raw, Boolean(album));
  const text = msg.body?.trim();
  if (text && config.groups.has(chatId) && (!found || found.command.kind === "conversation")) {
    const name = await namesOf([sender.id]);
    record(chatId, {
      id: messageId(raw.id),
      uid: raw.id.fromMe ? "yo" : sender.id,
      name: name[0] ?? "",
      text: await withNames(text),
      at,
    });
  }
  if (!found) return maybeFollowUp(msg, raw, sender, chatId);
  const req = await requestOf(msg, raw, sender, found);
  await ACTIONS[found.command.kind]({ ...req, album }, found.command.value ?? "");
}

// Lo que llegó mientras el bot se reiniciaba no vuelve a llegar: se busca en la página
export async function catchUp() {
  const since = Math.max(seenAt, Date.now() - RECENT_MS) / 1000;
  const ids = await page().evaluate((since) => {
    const all = window.require("WAWebCollections").Msg.getModelsArray() as unknown as Loose[];
    const missed = all.filter((m) => Number(m.t) > since && !m.id.fromMe);
    return missed.sort((a, b) => Number(a.t) - Number(b.t)).map((m) => String(m.id));
  }, since);
  for (const id of ids) {
    const msg = await client.getMessageById(id);
    if (msg) await onMessage(msg);
  }
}

export const onMessage = (msg: Message) =>
  handle(msg).catch((err) => log.error("No se pudo atender un mensaje", err));
