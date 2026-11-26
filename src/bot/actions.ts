import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { Message } from "whatsapp-web.js";
import pkg from "../../package.json" with { type: "json" };
import { loadImage, talk, withNames } from "../ai/followup.ts";
import texts from "../ai/prompts.json" with { type: "json" };
import { today } from "../ai/spend.ts";
import { ROOT, config } from "../config.ts";
import { botError, errorDetail, log } from "../log.ts";
import { findLink, linkMedia, type Link, type LinkItem } from "../links/index.ts";
import {
  MAX_AUDIO_SECONDS as MAX_MEDIA_AUDIO_SECONDS,
  MAX_CLIP_SECONDS,
  findYoutube,
  parseRange,
  rangeLength,
  toAudio,
  toVideo,
  youtubeAudio,
  youtubeVideo,
  type Range,
} from "../media/clip.ts";
import { bubble } from "../sticker/bubble.ts";
import {
  MAX_SECONDS,
  toSticker,
  toStickerAudio,
  type AudioTrack,
  type Ratio,
} from "../sticker/tools.ts";
import { connectionState } from "../wa/client.ts";
import { chatOf, isGroup, messageId, messageKey, selfId, widOf } from "../wa/identity.ts";
import type { Raw, Sender } from "../wa/identity.ts";
import { download, downloadAudio, hasAudio, hasMedia, imageType, type Media } from "../wa/media.ts";
import { enqueue, quotedId, send, type SendOptions } from "../wa/send.ts";
import { isOwner } from "./access.ts";
import type { Command } from "./commands.ts";
import { MAX_CATCHUP_MS, getAlbum, isDone, markDone, type Album } from "./handle.ts";
import { limitNotice, refund, take, type Use } from "./quota.ts";
import type { Route } from "./route.ts";

type Base = { msg: Message; raw: Raw; chatId: string; sender: Sender; route: Route };
type Extra = {
  quote?: string;
  notified?: boolean;
  noRefund?: boolean;
  retry?: boolean;
  album?: Album;
  audioLoad?: AudioTrack | (() => Promise<Media>);
};
export type Request = Base & Extra;
type Options = SendOptions;
type Make = (last: boolean) => Promise<string | Media | null>;
type Sent = (id: string | null) => void;
type Delivery = { kind: "sent"; id: string } | { kind: "skipped" | "uncertain" };
type Visual = { key?: string; load: () => Promise<Media> };
type PendingSource =
  | { need: "audio"; visuals: Visual[] }
  | { need: "visual"; audio: AudioTrack };
type PendingAudio = PendingSource & { at: number; ratio?: Ratio; promptId: string; replyKey?: string };

const ASSETS = join(ROOT, "assets");
const STICKER: Options = { sendMediaAsSticker: true };
const PENDING_TTL_MS = 60_000;
const pendingAudio = new Map<string, PendingAudio>();
const PERMANENT_ERRORS = new Set([
  "media_expired",
  "media_download",
  "clip_no_video",
  "clip_no_audio",
  "clip_range",
  "clip_long",
  "clip_large",
  "clip_live",
  "sticker_size",
  "audio_sticker_unsupported",
  "link_host",
  "link_redirects",
  "link_size",
  "x",
  "twitter",
  "tiktok",
  "instagram",
  "ai_401",
]);

function isPermanentError(err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e?.code && PERMANENT_ERRORS.has(e.code)) return true;
  if (e?.code === "link_http" || e?.code === "media_http") {
    const code = Number(e.message?.match(/HTTP (\d+)/)?.[1] ?? 0);
    return code >= 400 && code < 500 && code !== 429;
  }
  return false;
}

const pendingKey = (chatId: string, sender: Sender) => `${chatId}:${sender.key}`;

function peekPending(chatId: string, sender: Sender) {
  const now = Date.now();
  for (const [key, entry] of pendingAudio) {
    if (now - entry.at > (entry.replyKey ? MAX_CATCHUP_MS : PENDING_TTL_MS)) pendingAudio.delete(key);
  }
  return pendingAudio.get(pendingKey(chatId, sender));
}

function clearPending(req: Request) {
  pendingAudio.delete(pendingKey(req.chatId, req.sender));
}

export async function requestOf(msg: Message, raw: Raw, sender: Sender, route: Route): Promise<Request> {
  const quote = raw.quotedMsg && route.command.kind !== "conversation" ? await quotedId(raw) : undefined;
  return { msg, raw, chatId: chatOf(raw), sender, route, quote };
}

function failedDelivery(req: Request, err: unknown, context: string): Delivery {
  log.error(context, err);
  if ((err as { code?: string } | null)?.code === "wa_send_uncertain") return { kind: "uncertain" };
  if (!isPermanentError(err)) req.retry = true;
  return { kind: "skipped" };
}

async function deliver(req: Request, content: string | Media, options: Options): Promise<Delivery> {
  try {
    return { kind: "sent", id: await send(req.chatId, content, options) };
  } catch (err) {
    return failedDelivery(req, err, "Could not send a response");
  }
}

export function reply(req: Request, use: Use, prepare: Make, options: Options = {}, sent?: Sent): Promise<Delivery> {
  const taken = take(use, req.chatId, req.sender);
  if ("resetAt" in taken) {
    if (use === "conversation" || req.notified) return Promise.resolve({ kind: "skipped" });
    req.notified = true;
    return hint(req, limitNotice(taken));
  }
  const prepared = Promise.resolve().then(() => prepare(taken.last)).then(
    (payload) => ({ payload }),
    (err) => failedDelivery(req, err, "Could not prepare a response"),
  );
  return enqueue(req.chatId, async () => {
    const ready = await prepared;
    let result: Delivery = "kind" in ready ? ready : { kind: "skipped" };
    if ("payload" in ready && ready.payload != null) {
      result = await deliver(req, ready.payload, {
        ...options,
        quotedMessageId: req.quote ?? messageId(req.raw.id),
      });
    }
    if (result.kind === "sent" || result.kind === "uncertain") {
      try {
        sent?.(result.kind === "sent" ? result.id : null);
      } catch (err) {
        console.error("Could not record response progress", errorDetail(err));
      }
    } else if (!req.noRefund) refund(taken);
    return result;
  });
}

const hint = (req: Request, text: string, quotedMessageId = messageId(req.raw.id)) =>
  enqueue(req.chatId, () => deliver(req, text, { quotedMessageId }));

async function waitForStickerSource(req: Request, source: PendingSource, ratio = req.route.ratio) {
  const text = source.need === "audio"
    ? "Esperando audio. Responde a este mensaje con un audio o una nota de voz."
    : "Esperando imagen o video. Responde a este mensaje con el archivo o enlace.";
  const direct = req.album || hasMedia(req.raw) || hasAudio(req.raw) || findLink(req.msg.body);
  const prompt = await hint(req, text, direct ? undefined : req.quote);
  if (prompt.kind === "sent") {
    pendingAudio.set(pendingKey(req.chatId, req.sender), { ...source, at: Date.now(), ratio, promptId: prompt.id });
  }
}

const itemKeyOf = (req: Request, v: Visual, i: number) =>
  v.key ?? `${messageKey(req.raw.id)}#${i}`;

const sticker = (req: Request, load: () => Promise<Media>, key?: string, audio?: AudioTrack, ratio = req.route.ratio) => {
  if (key && isDone(key)) return;
  return reply(
    req,
    "replies",
    async () => toSticker(await load(), ratio),
    audio ? { ...STICKER, stickerAudio: audio } : STICKER,
    () => key && markDone(key),
  );
};

const file = async (path: string, mimetype: string) => ({ data: await readFile(path), mimetype });

// Una nota de voz: WhatsApp espera Ogg con Opus y este tipo exacto
const voiceNote = (name: string) => file(join(ASSETS, "audios", name), "audio/ogg; codecs=opus");
const authorOf = (req: Request) => (req.raw.id.fromMe ? selfId() : req.sender.id);

export const albumItemKey = (req: Request, item: Raw) => `${messageKey(req.raw.id)}#${messageKey(item.id)}`;

function albumVisuals(req: Request, items: Raw[]): Visual[] {
  return items.map((item) => ({
    key: albumItemKey(req, item),
    load: () => download(item),
  }));
}

export function requestAlbum(album: Album, req: Request, items?: Raw[]) {
  if (!items) album.request = req;
  const visuals = albumVisuals(req, items ?? album.items);
  if (req.route.audio) {
    if (req.audioLoad) return sendAudioVisuals(req, visuals, req.audioLoad);
    const pending = peekPending(req.chatId, req.sender);
    if (pending?.need === "audio") {
      for (const visual of visuals) {
        if (!pending.visuals.some(({ key }) => key === visual.key)) pending.visuals.push(visual);
      }
    }
    return;
  }
  return Promise.all(visuals.map((v) => sticker(req, v.load, v.key)));
}

async function resolveLinkItems(req: Request, { provider, url }: Link): Promise<LinkItem[] | null> {
  try {
    return await provider.resolve(url);
  } catch (err) {
    log.error(`Could not resolve the ${provider.name} link`, err);
    if (!isPermanentError(err)) req.retry = true;
    return null;
  }
}

async function linkVisuals(req: Request, link: Link): Promise<Visual[] | undefined> {
  const items = await resolveLinkItems(req, link);
  if (items?.length) return items.map((item) => ({ load: () => linkMedia(item) }));
}

async function linkStickers(req: Request, link: Link) {
  const visuals = await linkVisuals(req, link);
  if (!visuals) return;
  const base = messageKey(req.raw.id);
  return Promise.all(visuals.map((visual, i) => sticker(req, visual.load, `${base}#${i}`)));
}

async function sendAudioVisuals(
  req: Request,
  visuals: Visual[],
  audio: AudioTrack | (() => Promise<Media>),
  ratio = req.route.ratio,
) {
  const entry = peekPending(req.chatId, req.sender);
  let track: AudioTrack | null;
  try {
    track = "seconds" in audio ? audio : await toStickerAudio(await audio());
  } catch (err) {
    return failedDelivery(req, err, "Could not prepare sticker audio");
  }
  if (!visuals.length) {
    if (!track) return hint(req, "Envía una imagen, un video o un audio.");
    return waitForStickerSource(req, { need: "visual", audio: track }, ratio);
  }
  if (req.album?.request === req) req.audioLoad = track ?? undefined;
  if (!track) {
    return waitForStickerSource(req, { need: "audio", visuals }, ratio);
  }
  const results = await Promise.all(
    visuals.map((v, i) => sticker(req, v.load, itemKeyOf(req, v, i), track, ratio)),
  );
  if (entry && !req.retry && pendingAudio.get(pendingKey(req.chatId, req.sender)) === entry) clearPending(req);
  return results;
}

async function linkAudioSource(req: Request, link: Link): Promise<(() => Promise<Media>) | null> {
  const items = await resolveLinkItems(req, link);
  const first = items?.[0];
  if (!first) return null;
  return () => linkMedia(first.audio ?? first);
}

async function linkAudioStickers(req: Request, link: Link) {
  const items = await resolveLinkItems(req, link);
  if (!items?.length) return;
  const base = messageKey(req.raw.id);
  const pending = items
    .map((item, i) => ({ item, key: `${base}#${i}` }))
    .filter(({ key }) => !isDone(key));
  const sharedAudio = pending.length && items[0]?.audio
    ? linkMedia(items[0].audio).then((m) => toStickerAudio(m))
    : null;
  sharedAudio?.catch(() => undefined);
  const downloaded = await Promise.all(
    pending.map(async ({ item, key }) => {
      const vis = await linkMedia(item);
      const audio = sharedAudio ? await sharedAudio : await toStickerAudio(vis, MAX_SECONDS);
      return { vis, audio, key };
    }),
  );
  if (pending.length < items.length || downloaded.some(({ audio }) => audio)) {
    clearPending(req);
    return Promise.all(
      downloaded.map(({ vis, audio, key }) => audio && sticker(req, async () => vis, key, audio)),
    );
  }
  const visuals: Visual[] = downloaded.map((d) => ({ load: async () => d.vis }));
  return waitForStickerSource(req, { need: "audio", visuals });
}

function directAndQuotedVisuals(req: Request) {
  const { raw, album, chatId } = req;
  const quoted = raw.quotedMsg;
  const bodyLink = findLink(req.msg.body);
  const quotedLink = quoted?.type === "chat" ? findLink(quoted.body) : null;
  const quotedAlbum = quoted?.type === "album" ? getAlbum(raw.quotedStanzaID ?? "") : null;
  const directVisuals: Visual[] = album
    ? albumVisuals(req, album.items)
    : hasMedia(raw)
      ? [{ load: () => download(raw) }]
      : [];
  if (quotedAlbum?.items.length === 0) {
    log.warn("Álbum fuera del historial del bot: hay que reenviarlo.");
  }
  const quotedVisuals: Visual[] = quotedAlbum
    ? albumVisuals(req, quotedAlbum.items)
    : hasMedia(quoted)
      ? [{ load: () => download(quoted!) }]
      : quoted?.type === "chat" && quoted.body && !quotedLink
        ? [
            {
              load: () =>
                bubble({
                  authorId: widOf(raw.quotedParticipant) || chatId,
                  stanzaId: raw.quotedStanzaID,
                  body: quoted.body!,
                  chatId,
                }),
            },
          ]
        : [];
  return { directVisuals, quotedVisuals, bodyLink, quotedLink };
}

async function audioStickerOf(req: Request) {
  const { raw, album } = req;
  const quoted = raw.quotedMsg;
  const entry = peekPending(req.chatId, req.sender);
  if (entry && entry.promptId === req.quote && await completePendingAudio(req, entry)) return;
  const { directVisuals, quotedVisuals, bodyLink, quotedLink } = directAndQuotedVisuals(req);

  if (directVisuals.length && (hasAudio(quoted) || quoted?.type === "video" || bodyLink || quotedLink)) {
    const audio = hasAudio(quoted)
      ? () => downloadAudio(quoted!)
      : quoted?.type === "video"
        ? () => download(quoted)
        : await linkAudioSource(req, (bodyLink ?? quotedLink)!);
    if (!audio) return;
    if (album) {
      req.audioLoad = audio;
      album.request = req;
    }
    return sendAudioVisuals(req, directVisuals, audio);
  }
  if (hasAudio(raw) && (quotedVisuals.length || quotedLink)) {
    const audio = () => downloadAudio(raw);
    if (quotedVisuals.length) return sendAudioVisuals(req, quotedVisuals, audio);
    const visuals = await linkVisuals(req, quotedLink!);
    if (visuals) return sendAudioVisuals(req, visuals, audio);
    return;
  }
  if (quotedVisuals.length && bodyLink) {
    const audio = await linkAudioSource(req, bodyLink);
    if (!audio) return;
    return sendAudioVisuals(req, quotedVisuals, audio);
  }
  if (hasAudio(quoted) && bodyLink) {
    const visuals = await linkVisuals(req, bodyLink);
    if (visuals) return sendAudioVisuals(req, visuals, () => downloadAudio(quoted!));
    return;
  }

  const link = bodyLink ?? quotedLink;
  if (link) return linkAudioStickers(req, link);

  const visuals = directVisuals.length ? directVisuals : quotedVisuals;
  const videoItem =
    directVisuals.length && raw.type === "video"
      ? raw
      : !directVisuals.length && quoted?.type === "video"
        ? quoted
        : null;
  const quotedAudioSticker = !directVisuals.length && quoted?.type === "sticker" && hasAudio(quoted);

  if (quotedAudioSticker) {
    return sendAudioVisuals(req, quotedVisuals, () => downloadAudio(quoted!));
  }
  if (visuals.length) {
    if (videoItem) {
      const media = await download(videoItem);
      const track = await toStickerAudio(media, MAX_SECONDS);
      if (track) {
        clearPending(req);
        return sticker(req, async () => media, itemKeyOf(req, visuals[0]!, 0), track);
      }
      return waitForStickerSource(req, { need: "audio", visuals: [{ load: async () => media }] });
    }
    return waitForStickerSource(req, { need: "audio", visuals });
  }

  const audioItem = hasAudio(raw) ? raw : hasAudio(quoted) ? quoted : null;
  if (audioItem) {
    const track = await toStickerAudio(await downloadAudio(audioItem));
    if (!track) return;
    return waitForStickerSource(req, { need: "visual", audio: track });
  }

  return hint(req, "Envía una imagen, un video o un audio.");
}

async function completePendingAudio(req: Request, entry: PendingAudio) {
  const { raw, album } = req;
  const link = entry.need === "visual" && !album && !hasMedia(raw) ? findLink(req.msg.body) : null;
  if (entry.need === "audio" ? !hasAudio(raw) : !hasMedia(raw) && !album && !link) return false;
  const key = messageKey(raw.id);
  if (entry.replyKey && entry.replyKey !== key) return true;
  if (!entry.replyKey) entry.at = Date.now();
  entry.replyKey = key;
  const ratio = req.route.ratio ?? entry.ratio;
  try {
    if (entry.need === "audio") {
      await sendAudioVisuals(req, entry.visuals, () => downloadAudio(raw), ratio);
    } else if (link) {
      const visuals = await linkVisuals(req, link);
      if (visuals) await sendAudioVisuals(req, visuals, entry.audio, ratio);
    } else {
      if (album) {
        req.audioLoad = entry.audio;
        req.route.ratio = ratio;
        album.request = req;
      }
      const visuals = album ? albumVisuals(req, album.items) : [{ load: () => download(raw) }];
      await sendAudioVisuals(req, visuals, entry.audio, ratio);
    }
  } catch (err) {
    failedDelivery(req, err, "Could not complete the audio sticker");
  } finally {
    if (!req.retry) delete entry.replyKey;
  }
  return true;
}

export async function consumePendingAudio(
  msg: Message,
  raw: Raw,
  sender: Sender,
  chatId: string,
  album?: Album,
): Promise<Request | null> {
  const entry = peekPending(chatId, sender);
  if (!entry || !raw.quotedMsg) return null;
  const req = await requestOf(msg, raw, sender, { command: { kind: "sticker" }, text: "", audio: true });
  req.album = album;
  return req.quote === entry.promptId && await completePendingAudio(req, entry) ? req : null;
}

function stickerOf(req: Request) {
  if (req.route.audio) return audioStickerOf(req);
  const { raw, album, chatId } = req;
  const quoted = raw.quotedMsg;
  const key = `${messageKey(raw.id)}#0`;
  if (album) {
    if (album.request && messageKey(album.request.raw.id) !== messageKey(raw.id)) return;
    return requestAlbum(album, req);
  }
  if (hasMedia(raw)) return sticker(req, () => download(raw), key);
  const link = findLink(quoted ? quoted.body : req.msg.body);
  if (!quoted) return link && linkStickers(req, link);
  if (hasMedia(quoted)) return sticker(req, () => download(quoted), key);
  const found = quoted.type === "album" ? getAlbum(raw.quotedStanzaID ?? "") : null;
  if (found?.items.length === 0) log.warn("Álbum fuera del historial del bot: hay que reenviarlo.");
  if (found) return requestAlbum(found, req);
  if (quoted.type !== "chat" || !quoted.body) return;
  if (link) return linkStickers(req, link);
  const author = { authorId: widOf(raw.quotedParticipant) || chatId, stanzaId: raw.quotedStanzaID };
  return sticker(req, () => bubble({ ...author, body: quoted.body!, chatId }), key);
}

const mediaText = (req: Request) => {
  const quoted = req.raw.quotedMsg?.body ?? "";
  return `${req.route.text} ${quoted}`.trim();
};

const attachedVideo = ({ raw }: Request) =>
  [raw, raw.quotedMsg].find((item) => item?.type === "video" && hasMedia(item));

async function playable(items: LinkItem[], range: Range | null | undefined, kind: "video" | "audio") {
  const wrong = kind === "video" ? "clip_no_video" : "clip_no_audio";
  for (const item of items) {
    const source = kind === "audio" ? (item.audio ?? item) : item;
    const media = await linkMedia(source, kind);
    try {
      return kind === "video" ? await toVideo(media, range) : await toAudio(media, range);
    } catch (err) {
      if ((err as { code?: string }).code !== wrong) throw err;
    }
  }
  throw botError(wrong, kind === "video" ? "That link has no video." : "That link has no audio.");
}

function video(req: Request) {
  const text = mediaText(req);
  if (parseRange(text)) return hint(req, "Para recortar, usa !clip.");
  return sendVideo(req, text);
}

function clip(req: Request) {
  const text = mediaText(req);
  const range = parseRange(text);
  if (!range) return hint(req, "Usa !clip 1:30-1:45 <enlace>.");
  if (rangeLength(range) > MAX_CLIP_SECONDS) return hint(req, "Máximo 60s");
  return sendVideo(req, text, range);
}

function sendVideo(req: Request, text: string, range?: Range) {
  const youtube = findYoutube(text);
  const link = youtube ? null : findLink(text);
  const source = attachedVideo(req);
  if (!youtube && !link && !source) return hint(req, "Envía un enlace o un video.");
  return reply(
    req,
    "replies",
    async () => {
      if (youtube) return youtubeVideo(youtube, range);
      if (link) {
        const items = await resolveLinkItems(req, link);
        return items && playable(items, range, "video");
      }
      return toVideo(await download(source!), range);
    },
  );
}

async function audio(req: Request) {
  const text = mediaText(req);
  const range = parseRange(text);
  if (range && rangeLength(range) > MAX_MEDIA_AUDIO_SECONDS) return hint(req, "Máximo 10 min.");
  const youtube = findYoutube(text);
  const link = youtube ? null : findLink(text);
  const video = attachedVideo(req);
  const audioItem = hasAudio(req.raw) ? req.raw : hasAudio(req.raw.quotedMsg) ? req.raw.quotedMsg : null;
  if (!youtube && !link && !video && !audioItem) {
    return hint(req, "Envía un enlace o un video.");
  }
  return reply(
    req,
    "replies",
    async () => {
      if (youtube) return youtubeAudio(youtube, range);
      if (link) {
        const items = await resolveLinkItems(req, link);
        return items && playable(items, range, "audio");
      }
      if (video) return toAudio(await download(video), range);
      if (audioItem) return toAudio(await downloadAudio(audioItem), range);
      throw botError("clip_no_audio", "That link has no audio.");
    },
  );
}

async function celebrate(req: Request) {
  const names = await readdir(join(ASSETS, "celebration")).catch(() => []);
  const files = names.filter((name) => name.toLowerCase().endsWith(".webp")).sort();
  if (!files.length) return log.warn("No hay stickers de festejo en assets/celebration.");
  const chosen = files[Math.floor(Math.random() * files.length)]!;
  return sticker(req, () => file(join(ASSETS, "celebration", chosen), "image/webp"), `${messageKey(req.raw.id)}#0`);
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
  audioSticker: audioStickerOf,
  clip,
  video,
  audio,
  celebrate,
  status,
  conversation,
  quickReplies: (req, text) => reply(req, "replies", async () => text),
  textReplies: (req, body) =>
    sticker(req, () => bubble({ body, authorId: authorOf(req), chatId: req.chatId }), `${messageKey(req.raw.id)}#0`),
  stickers: (req, name) =>
    sticker(req, () => file(join(ASSETS, "stickers", name), "image/webp"), `${messageKey(req.raw.id)}#0`),
  audios: (req, name) => reply(req, "replies", () => voiceNote(name), { sendAudioAsVoice: true }),
};
