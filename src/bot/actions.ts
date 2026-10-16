import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { Message } from "whatsapp-web.js";
import pkg from "../../package.json" with { type: "json" };
import { loadImage, talk, withNames } from "../ai/followup.ts";
import texts from "../ai/prompts.json" with { type: "json" };
import { today } from "../ai/spend.ts";
import { ROOT, config } from "../config.ts";
import { log } from "../log.ts";
import { findLink, linkMedia, type Link } from "../links/index.ts";
import { bubble } from "../sticker/bubble.ts";
import { toSticker } from "../sticker/tools.ts";
import { connectionState } from "../wa/client.ts";
import { chatOf, isGroup, messageId, selfId, widOf } from "../wa/identity.ts";
import type { Raw, Sender } from "../wa/identity.ts";
import { download, hasMedia, imageType, type Media } from "../wa/media.ts";
import { enqueue, quotedId, send } from "../wa/send.ts";
import { isOwner } from "./access.ts";
import type { Command } from "./commands.ts";
import { getAlbum, type Album } from "./handle.ts";
import { limitNotice, refund, take, type Use } from "./quota.ts";
import type { Route } from "./route.ts";

type Base = { msg: Message; raw: Raw; chatId: string; sender: Sender; route: Route };
type Extra = { quote?: string; notified?: boolean; noRefund?: boolean; album?: Album };
export type Request = Base & Extra;
type Options = { sendMediaAsSticker?: boolean; sendAudioAsVoice?: boolean };
type Make = (last: boolean) => Promise<string | Media | null>;
type Sent = (id: string | null) => void;
const ASSETS = join(ROOT, "assets");
const STICKER = { sendMediaAsSticker: true };

export async function requestOf(msg: Message, raw: Raw, sender: Sender, route: Route) {
  const quote = raw.quotedMsg ? await quotedId(raw) : undefined;
  return { msg, raw, chatId: chatOf(raw), sender, route, quote } as Request;
}

// Todo envío pasa por aquí: gasta el cupo y lo devuelve si falla
export function reply(req: Request, use: Use, prepare: Make, options: Options = {}, sent?: Sent) {
  const taken = take(use, req.chatId, req.sender);
  if ("resetAt" in taken) {
    if (use === "conversation" || req.notified) return;
    req.notified = true;
    const cite = { quotedMessageId: messageId(req.raw.id) };
    return enqueue(req.chatId, () => send(req.chatId, limitNotice(taken), cite));
  }
  const prepared = prepare(taken.last);
  prepared.catch(() => undefined); // el error se registra al enviar
  const full = { quotedMessageId: req.quote, ...options };
  return enqueue(req.chatId, async () => {
    try {
      const content = await prepared;
      if (content != null) await send(req.chatId, content, full).then(sent);
      else if (!req.noRefund) refund(taken);
    } catch (err) {
      if (!req.noRefund) refund(taken);
      if ((err as { code?: string }).code !== "media_expired") throw err;
      log.warn("Archivo fuera del historial de WhatsApp: hay que reenviarlo", err);
    }
  });
}

const sticker = (req: Request, load: () => Promise<Media>) =>
  reply(req, "replies", async () => toSticker(await load(), req.route.ratio), STICKER);

const file = async (path: string, mimetype: string) => ({ data: await readFile(path), mimetype });

// Una nota de voz: WhatsApp espera Ogg con Opus y este tipo exacto
const voiceNote = (name: string) => file(join(ASSETS, "audios", name), "audio/ogg; codecs=opus");
const authorOf = (req: Request) => (req.raw.id.fromMe ? selfId() : req.sender.id);

export function requestAlbum(album: Album, req: Request, items = album.items) {
  album.request = req;
  return Promise.all(items.map((item) => sticker(req, () => download(item))));
}

const linkStickers = (req: Request, { provider, url }: Link) =>
  provider.resolve(url).then(
    (items) => Promise.all(items.map((item) => sticker(req, () => linkMedia(item)))),
    (err) => log.error(`No se pudo resolver el enlace de ${provider.name}`, err),
  );

function stickerOf(req: Request) {
  const { raw, album, chatId } = req;
  const quoted = raw.quotedMsg;
  if (album) return album.request ? undefined : requestAlbum(album, req);
  if (hasMedia(raw)) return sticker(req, () => download(raw));
  const link = findLink(quoted ? quoted.body : req.msg.body);
  if (!quoted) return link && linkStickers(req, link);
  if (hasMedia(quoted)) return sticker(req, () => download(quoted));
  const found = quoted.type === "album" ? getAlbum(raw.quotedStanzaID ?? "") : null;
  if (found?.items.length === 0) log.warn("Álbum fuera del historial del bot: hay que reenviarlo.");
  if (found) return requestAlbum(found, req);
  if (quoted.type !== "chat" || !quoted.body) return;
  if (link) return linkStickers(req, link);
  const author = { authorId: widOf(raw.quotedParticipant) || chatId, stanzaId: raw.quotedStanzaID };
  return sticker(req, () => bubble({ ...author, body: quoted.body!, chatId }));
}

async function celebrate(req: Request) {
  const names = await readdir(join(ASSETS, "celebration")).catch(() => []);
  const files = names.filter((name) => name.toLowerCase().endsWith(".webp")).sort();
  if (!files.length) return log.warn("No hay stickers de festejo en assets/celebration.");
  const chosen = files[Math.floor(Math.random() * files.length)]!;
  return sticker(req, () => file(join(ASSETS, "celebration", chosen), "image/webp"));
}

async function status(req: Request) {
  if (!isOwner(req.sender) || isGroup(req.chatId)) return;
  const state = await connectionState().catch(() => "sin respuesta");
  const lines = [`Conexión: ${state}`, `En marcha: ${(process.uptime() / 3600).toFixed(1)} h`];
  lines.push(`Gasto de hoy: ${today().usd.toFixed(3)} de ${config.ai?.dailyBudgetUsd ?? 0} USD`);
  lines.push(`Búsquedas: ${today().searches} de ${config.ai?.maxSearchesPerDay ?? "sin límite"}`);
  lines.push(`Versión: ${pkg.version}`);
  return reply(req, "replies", async () => lines.join("\n"));
}

async function conversation(req: Request) {
  const { raw } = req;
  const quoted = raw.quotedMsg;
  const quoteText = quoted?.type === "chat" && quoted.body ? await withNames(quoted.body) : "";
  const quote = quoteText ? { text: quoteText, uid: widOf(raw.quotedParticipant) } : null;
  const withImage = [raw, quoted].find((item) => imageType(item));
  const image = withImage ? await loadImage(withImage) : null;
  const types = [raw.type, quoted?.type] as (keyof typeof texts.unseen)[];
  const unseen = types.map((type) => texts.unseen[type]).find(Boolean);
  const attachment = withImage ? texts.unreadableImage : unseen;
  req.quote = messageId(raw.id);
  const at = raw.t ? raw.t * 1000 : Date.now();
  const seen = { image, attachment: image ? undefined : attachment, msgId: req.quote, at };
  return talk(req, { kind: "call", text: await withNames(req.route.text), quote, ...seen });
}

export const ACTIONS: Record<Command["kind"], (req: Request, value: string) => unknown> = {
  sticker: stickerOf,
  celebrate,
  status,
  conversation,
  quickReplies: (req, text) => reply(req, "replies", async () => text),
  textReplies: (req, body) =>
    sticker(req, () => bubble({ body, authorId: authorOf(req), chatId: req.chatId })),
  stickers: (req, name) => sticker(req, () => file(join(ASSETS, "stickers", name), "image/webp")),
  audios: (req, name) => reply(req, "replies", () => voiceNote(name), { sendAudioAsVoice: true }),
};
