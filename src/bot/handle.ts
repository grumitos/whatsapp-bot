import { join } from "path";
import type { Message } from "whatsapp-web.js";
import { maybeFollowUp, withNames } from "../ai/followup.ts";
import { record } from "../ai/store.ts";
import { DATA_DIR, config } from "../config.ts";
import { log } from "../log.ts";
import { readJson, writeJson } from "../store.ts";
import { client, page, type Loose } from "../wa/client.ts";
import { chatOf, messageId, messageKey, namesOf, rawOf, senderOf, type Raw } from "../wa/identity.ts";
import { hasMedia } from "../wa/media.ts";
import { onSent, waitForOwnSend } from "../wa/send.ts";
import { mayUse } from "./access.ts";
import { ACTIONS, albumItemKey, consumePendingAudio, requestAlbum, requestOf, type Request } from "./actions.ts";
import { route } from "./route.ts";

export type Album = { at: number; items: Raw[]; request: Request | null };
type Seen = { at?: number; recoverFrom?: number; done?: Record<string, number> };
const ALBUM_MS = 24 * 3_600_000;
const albums = new Map<string, Album>();
const SEEN = join(DATA_DIR, "seen.json");
const BOOT_WINDOW_MS = 5 * 60_000;
export const MAX_CATCHUP_MS = 30 * 60_000;
const DONE_TTL_MS = 24 * 3_600_000;
const DONE_MAX = 5000;

const saved = readJson<Seen>(SEEN, {});
let seenAt = typeof saved.at === "number" ? saved.at : 0;
// Los mensajes nuevos no desplazan los pendientes dentro de la ventana de recuperación.
let recoverFrom = saved.recoverFrom ??
  (seenAt ? seenAt + (saved.done ? -BOOT_WINDOW_MS : 1) : Date.now() - BOOT_WINDOW_MS);
const done = new Map<string, number>(Object.entries(saved.done ?? {}));
const inFlight = new Set<string>();
let catching: Promise<void> | null = null;

function pruneDone() {
  const oldest = Date.now() - DONE_TTL_MS;
  for (const [key, ts] of done) if (ts < oldest) done.delete(key);
  while (done.size > DONE_MAX) {
    const first = done.keys().next().value;
    if (first === undefined) break;
    done.delete(first);
  }
}

function saveSeen() {
  pruneDone();
  writeJson(SEEN, { at: seenAt, recoverFrom, done: Object.fromEntries(done) });
}

export const isDone = (key: string) => done.has(key);

export function markDone(key: string, at = 0) {
  done.delete(key);
  done.set(key, Date.now());
  if (at > seenAt) seenAt = at;
  saveSeen();
}

onSent(markDone);

// Las fotos de un envío múltiple llegan sueltas, enlazadas a un mensaje "album" sin imagen
export function getAlbum(id: string) {
  for (const [key, album] of albums) if (Date.now() - album.at > ALBUM_MS) albums.delete(key);
  const album = albums.get(id) ?? { at: Date.now(), items: [], request: null };
  albums.set(id, album);
  return album;
}

const isHiddenCompanion = (raw: Raw) =>
  raw.viewMode === "HIDDEN" || Boolean(raw.associationType?.endsWith("_DUAL_UPLOAD"));

// message_create también trae lo que envía el propio número: así el dueño usa el bot desde él
export async function handle(msg: Message) {
  const raw = rawOf(msg);
  const id = messageKey(raw.id);
  const waId = messageId(raw.id);
  const at = (raw.t ?? 0) * 1000;
  // Un mensaje puede llegar dos veces (el evento y la recuperación tras reiniciar o pausar la VM)
  if (
    (at && at < Date.now() - MAX_CATCHUP_MS) ||
    isDone(id) ||
    isDone(waId) ||
    inFlight.has(id)
  ) return;
  inFlight.add(id);
  try {
    if (at && at < recoverFrom) {
      recoverFrom = at;
      saveSeen();
    }
    const chatId = chatOf(raw);
    if (/@(broadcast|newsletter)$/.test(chatId) || isHiddenCompanion(raw)) {
      markDone(id, at);
      return;
    }
    if (raw.id.fromMe) await waitForOwnSend(chatId);
    if (isDone(waId)) return;
    const sender = await senderOf(raw);
    if (!mayUse(chatId, sender)) {
      markDone(id, at);
      return;
    }
    const key =
      !raw.associationType || raw.associationType === "MEDIA_ALBUM" ? raw.parentMsgKey : undefined;
    const albumId = hasMedia(raw) && (typeof key === "string" ? key.split("_")[2] : key?.id);
    const album = albumId ? getAlbum(albumId) : undefined;
    if (album) {
      if (!album.items.some((item) => messageKey(item.id) === id)) album.items.push(raw);
      if (album.request && !isDone(albumItemKey(album.request, raw))) {
        const attempt = { ...album.request, retry: false };
        await requestAlbum(album, attempt, [raw]);
        if (attempt.retry) return;
      }
    }
    const found = await route(msg, raw, Boolean(album));
    const text = msg.body?.trim();
    if (text && config.groups.has(chatId) && (!found || found.command.kind === "conversation")) {
      const name = await namesOf([sender.id]);
      record(chatId, {
        id,
        uid: raw.id.fromMe ? "yo" : sender.id,
        name: name[0] ?? "",
        text: await withNames(text),
        at,
      });
    }
    if (!found) {
      const paired = await consumePendingAudio(msg, raw, sender, chatId, album);
      if (paired) {
        if (!paired.retry) markDone(id, at);
        return;
      }
      await maybeFollowUp(msg, raw, sender, chatId);
      markDone(id, at);
      return;
    }
    const req = await requestOf(msg, raw, sender, found);
    req.album = album;
    await ACTIONS[found.command.kind](req, found.command.value ?? "");
    if (!req.retry) markDone(id, at);
  } finally {
    inFlight.delete(id);
  }
}

// Lo que llegó mientras el bot se reiniciaba, estaba desconectado o con la VM pausada
export async function catchUp() {
  if (catching) return catching;
  catching = (async () => {
    const since = Math.ceil(Math.max(recoverFrom, Date.now() - MAX_CATCHUP_MS) / 1000);
    const candidates = await page().evaluate((since) => {
      const all = window.require("WAWebCollections").Msg.getModelsArray() as unknown as Loose[];
      const missed = all.filter(
        (m) =>
          Number(m.t) >= since &&
          String(m.viewMode ?? "") !== "HIDDEN" &&
          !String(m.associationType ?? "").endsWith("_DUAL_UPLOAD") &&
          (!m.id.fromMe || Boolean(m.body || m.caption)),
      );
      return missed.sort((a, b) => Number(a.t) - Number(b.t)).map((m) => String(m.id));
    }, since);
    for (const id of candidates) {
      if (isDone(id) || inFlight.has(id)) continue;
      const msg = await client.getMessageById(id);
      if (msg) await onMessage(msg);
    }
  })().finally(() => {
    catching = null;
  });
  return catching;
}

export const onMessage = (msg: Message) =>
  handle(msg).catch((err) => log.error("No se pudo atender un mensaje", err));
