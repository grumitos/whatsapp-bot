import type { MessageSendOptions as Options } from "whatsapp-web.js";
import { log } from "../log.ts";
import { client, page, type Loose } from "./client.ts";
import { chatOf, isGroup, messageId, widOf, type Raw } from "./identity.ts";
import { hideAudioId, toWhatsApp, type Media } from "./media.ts";

const STICKER = { stickerName: "Sticker", stickerAuthor: "StickerBot" };
const queues = new Map<string, Promise<unknown>>();

// Textos enviados que aún no vuelven por message_create: son el eco del propio bot
const pending = new Map<string, number>();
const fail = (err: unknown) => log.error("No se pudo enviar una respuesta", err);

export function enqueue(chatId: string, task: () => Promise<unknown>) {
  const next = (queues.get(chatId) ?? Promise.resolve()).then(task).catch(fail);
  queues.set(chatId, next);
  void next.then(() => queues.get(chatId) === next && queues.delete(chatId));
  return next;
}

function release(text: string) {
  const count = pending.get(text) ?? 0;
  void (count > 1 ? pending.set(text, count - 1) : pending.delete(text));
  return count > 0;
}

export const isEcho = (raw: Raw, body: string) => raw.id.fromMe && release(body);

// sendMessage puede volver vacío aunque el mensaje salga: el id se lee después en la página
const lastOwnId = (chatId: string) =>
  page().evaluate((chatId) => {
    const all = window.require("WAWebCollections").Msg.getModelsArray();
    const own = all.filter((m: Loose) => m.id.fromMe && String(m.id.remote) === chatId);
    return own.length ? String(own.at(-1).id) : null;
  }, chatId);

export async function send(chatId: string, content: string | Media, options: Options = {}) {
  const text = typeof content === "string" ? content : "";
  if (text) pending.set(text, (pending.get(text) ?? 0) + 1);
  if (options.sendAudioAsVoice) await hideAudioId();
  const body = text || toWhatsApp(content as Media);
  await client.sendMessage(chatId, body, { ...STICKER, ...options }).catch((err) => {
    release(text);
    throw err;
  });
  return lastOwnId(chatId);
}

// La cita trae solo el id corto, sin decir si el citado es propio: se busca completo en la página
export async function quotedId(raw: Raw) {
  const chatId = chatOf(raw);
  const author = isGroup(chatId) ? `_${widOf(raw.quotedParticipant)}` : "";
  const ids = [false, true].map((fromMe) => `${fromMe}_${chatId}_${raw.quotedStanzaID}${author}`);
  const lookup = async (stanzaId: string, ids: string[]) => {
    const { Msg } = window.require("WAWebCollections");
    const known = Msg.getModelsArray().find((m: Loose) => String(m.id.id) === stanzaId);
    if (known) return String(known.id);
    for (const id of ids)
      if (Msg.get(id) || (await Msg.getMessagesById([id]))?.messages?.[0]) return id;
    return null;
  };
  const found = page().evaluate(lookup, String(raw.quotedStanzaID), ids);
  return (await found.catch(() => null)) ?? messageId(raw.id);
}
