import type { MessageSendOptions as Options } from "whatsapp-web.js";
import { botError, errorDetail } from "../log.ts";
import { SIZE, webpInfo, type AudioTrack } from "../sticker/tools.ts";
import { client, page, type Loose } from "./client.ts";
import { chatOf, isGroup, messageId, widOf, type Raw } from "./identity.ts";
import { prepareMessage, toWhatsApp, type Media, type StickerAudio } from "./media.ts";

export type SendOptions = Options & {
  stickerAudio?: AudioTrack;
  extra?: Record<string, unknown>;
};

const STICKER = { stickerName: "Sticker", stickerAuthor: "StickerBot" };
const queues = new Map<string, Promise<unknown>>();
const sending = new Map<string, Promise<string>>();
let notifySent: ((id: string) => void) | undefined;

export const onSent = (fn: (id: string) => void) => {
  notifySent = fn;
};

export function enqueue<T>(chatId: string, task: () => Promise<T>) {
  const next = (queues.get(chatId) ?? Promise.resolve()).then(task);
  const tail = next.catch(() => undefined);
  queues.set(chatId, tail);
  void tail.then(() => queues.get(chatId) === tail && queues.delete(chatId));
  return next;
}

export const waitForOwnSend = (chatId: string) => sending.get(chatId)?.catch(() => undefined);

// Habilita en WhatsApp Web el soporte nativo de audioStickerMessage (recepción, envío y reproducción)
export async function enableSoundStickers() {
  await page()
    .evaluate(() => {
      try {
        const gating = window.require("WAWebSoundStickerGating");
        if (!gating) return;
        const yes = (() => true) as unknown as Loose;
        if (!gating.isSoundStickerConsumptionEnabled?.()) gating.isSoundStickerConsumptionEnabled = yes;
        if (!gating.isSoundStickerCreationEnabled?.()) gating.isSoundStickerCreationEnabled = yes;
        if (!gating.isSoundStickerPlaybackEnabled?.()) gating.isSoundStickerPlaybackEnabled = yes;
      } catch {}
    })
    .catch(() => undefined);
}

async function uploadStickerAudio(track: AudioTrack): Promise<StickerAudio> {
  return page()
    .evaluate(
      async ({ data, mimetype, seconds }) => {
        let uploadManager: Loose;
        let qpl: Loose;
        try {
          uploadManager = window.require("WAWebUploadManager");
          qpl = window.require("WAWebStartMediaUploadQpl");
          window.require("WAWebStickersGenerateStickerMessageProto");
        } catch {
          throw new Error("audio_sticker_unsupported");
        }
        const file = window.WWebJS.mediaInfoToFile({ data, mimetype });
        const filehash = String(await window.WWebJS.getFileHash(file));
        const raw = new Uint8Array(32);
        window.crypto.getRandomValues(raw);
        let bin = "";
        for (const b of raw) bin += String.fromCharCode(b);
        const mediaKey = btoa(bin);
        const up = await uploadManager.encryptAndUpload({
          blob: file,
          type: "audio",
          signal: new AbortController().signal,
          mediaKey,
          uploadQpl: qpl.startMediaUploadQpl({ entryPoint: "MediaUpload" }),
        });
        return {
          deprecatedMms3Url: up.url ? String(up.url) : null,
          directPath: up.directPath ? String(up.directPath) : null,
          mediaKey: up.mediaKey ? String(up.mediaKey) : mediaKey,
          mediaKeyTimestamp: Number(up.mediaKeyTimestamp) || Math.floor(Date.now() / 1000),
          filehash,
          encFilehash: up.encFilehash ? String(up.encFilehash) : null,
          size: Number(file.size),
          duration: seconds,
          mimetype,
        };
      },
      { data: track.data.toString("base64"), mimetype: track.mimetype, seconds: track.seconds },
    )
    .catch((err) => {
      if (err instanceof Error && err.message.includes("audio_sticker_unsupported")) {
        throw botError("audio_sticker_unsupported", "WhatsApp Web no soporta stickers con audio", err);
      }
      throw err;
    });
}

export async function send(chatId: string, content: string | Media, options: SendOptions = {}) {
  const { stickerAudio, ...rest } = options;
  await prepareMessage(Boolean(rest.sendAudioAsVoice) || typeof content !== "string");
  let extra = rest.extra ? { ...rest.extra } : undefined;
  if (rest.sendMediaAsSticker && typeof content !== "string") {
    const meta = webpInfo(content.data);
    const dims = meta
      ? { width: meta.width || SIZE, height: meta.height || SIZE, isAnimated: meta.animated }
      : undefined;
    if (stickerAudio) {
      await enableSoundStickers();
      const uploaded = await uploadStickerAudio(stickerAudio);
      extra = { ...extra, ...dims, stickerAudio: uploaded };
    } else if (dims) {
      extra = { ...extra, ...dims };
    }
  }
  const body = typeof content === "string" ? content : toWhatsApp(content);
  const task = client
    .sendMessage(chatId, body, {
      ...(rest.sendMediaAsSticker ? STICKER : {}),
      ...rest,
      ...(rest.quotedMessageId ? { ignoreQuoteErrors: false } : {}),
      ...(extra ? { extra } : {}),
      waitUntilMsgSent: true,
    } as Options)
    .then((message) => {
      const key = message?.id as Raw["id"] | undefined;
      if (!key?.id) throw botError("wa_send_uncertain", "WhatsApp did not return the sent message.");
      const id = messageId(key);
      try {
        notifySent?.(id);
      } catch (err) {
        console.error("Could not record the sent message", errorDetail(err));
      }
      return id;
    });
  sending.set(chatId, task);
  try {
    return await task;
  } finally {
    if (sending.get(chatId) === task) sending.delete(chatId);
  }
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
