import type { Message } from "whatsapp-web.js";
import { wasSaid } from "../ai/store.ts";
import { findLink } from "../links/index.ts";
import type { Ratio } from "../sticker/tools.ts";
import { chatOf, selfIds, widOf, type Raw } from "../wa/identity.ts";
import { hasAudio, hasMedia } from "../wa/media.ts";
import { findCommand, normalize, type Command } from "./commands.ts";

export type Route = { command: Command; text: string; ratio?: Ratio; audio?: boolean };
const STICKER: Command = { kind: "sticker" };
const AI: Command = { kind: "conversation" };
const RATIO = /(?:^|\s)\[?([1-9]\d?):([1-9]\d?)\]?(?=\s|$)/;
const AUDIO_FLAG = /(?:^|\s)(?:audio|sonido|sound)(?=\s|$)/i;

const NOISE =
  /^(?:(?:j[aeiou]){2,}j?|(?:ha){2,}h?|(?:he){2,}|k{2,}|x+d+|lo+l+|ok+|oki|vale|ya|jsjs\w*)$/;

export function isNoise(text: string) {
  const lower = text.normalize("NFKC").toLowerCase();
  const letters = lower.replace(/[\p{P}\p{S}\p{Cf}\p{Mn}\s]/gu, "");
  return !letters || NOISE.test(letters);
}

export const hasSource = (raw: Raw, body: string, album: boolean) =>
  album ||
  hasMedia(raw) ||
  hasMedia(raw.quotedMsg) ||
  raw.quotedMsg?.type === "album" ||
  Boolean(findLink(body) ?? findLink(raw.quotedMsg?.body));

function ownText(body: string, users: string[]) {
  const words = body.replace(/![\p{L}\p{N}]+/gu, (w) =>
    findCommand(w)?.kind === "conversation" ? "" : w,
  );
  const plain = users.reduce((text, user) => text.replaceAll(`@${user}`, ""), words);
  return plain.replace(/\s+/g, " ").trim();
}

function parseModifiers(body: string, users: string[]) {
  let cleaned = body.replace(/https?:\/\/[^\s<>"]+/gi, " ");
  for (const user of users) cleaned = cleaned.replaceAll(`@${user}`, " ");
  cleaned = cleaned.replace(/![\p{L}\p{N}]+/gu, (w) => (findCommand(w) ? " " : w));
  cleaned = normalize(cleaned);
  const ratioMatch = cleaned.match(RATIO);
  const ratio = ratioMatch?.slice(1, 3).map(Number) as Ratio | undefined;
  if (ratioMatch) cleaned = cleaned.replace(ratioMatch[0], " ");
  const audioMatch = cleaned.match(AUDIO_FLAG);
  if (audioMatch) cleaned = cleaned.replace(audioMatch[0], " ");
  return { ratio, audio: Boolean(audioMatch), clean: cleaned.replace(/\s+/g, " ").trim() };
}

export async function route(msg: Message, raw: Raw, album: boolean): Promise<Route | null> {
  const chatId = chatOf(raw);
  const body = msg.body ?? "";
  const written = findCommand(body);
  const self = await selfIds();
  const users = self.map((id) => id.split("@")[0]!);
  const text = ownText(body, users);
  if (written) {
    const { kind } = written;
    if (
      kind === "sticker" || kind === "audioSticker" || kind === "celebrate" ||
      kind === "textReplies" || kind === "stickers"
    ) {
      const { ratio, audio } = parseModifiers(body, users);
      return { command: written, text, ratio, audio: kind === "audioSticker" || (kind === "sticker" && audio) };
    }
    return { command: written, text };
  }
  const quotesAi = Boolean(raw.quotedStanzaID && wasSaid(chatId, raw.quotedStanzaID));
  const trivial = isNoise(text) && raw.type !== "image";
  const tagged = users.some((user) => body.includes(`@${user}`));
  const mentioned = tagged || msg.mentionedIds.some((id) => self.includes(widOf(id)));
  if (quotesAi && (!trivial || mentioned)) return { command: AI, text };
  if (!mentioned) return null;
  const mods = parseModifiers(body, users);
  const audioInput = mods.audio && (hasAudio(raw) || hasAudio(raw.quotedMsg));
  if (hasSource(raw, body, album) || audioInput || (raw.quotedMsg?.type === "chat" && isNoise(mods.clean))) {
    return { command: STICKER, text, ratio: mods.ratio, audio: mods.audio };
  }
  return { command: AI, text: isNoise(text) ? "" : text };
}
