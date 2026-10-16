import type { Message } from "whatsapp-web.js";
import { wasSaid } from "../ai/store.ts";
import { findLink } from "../links/index.ts";
import type { Ratio } from "../sticker/tools.ts";
import { chatOf, selfIds, widOf, type Raw } from "../wa/identity.ts";
import { hasMedia } from "../wa/media.ts";
import { findCommand, type Command } from "./commands.ts";

export type Route = { command: Command; text: string; ratio?: Ratio };
const STICKER: Command = { kind: "sticker" };
const AI: Command = { kind: "conversation" };
const RATIO = /^\s*\[?([1-9]\d?):([1-9]\d?)\]?(?=\s|$)/;

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
    findCommand(w)?.command.kind === "conversation" ? "" : w,
  );
  const plain = users.reduce((text, user) => text.replaceAll(`@${user}`, ""), words);
  return plain.replace(/\s+/g, " ").trim();
}

export async function route(msg: Message, raw: Raw, album: boolean): Promise<Route | null> {
  const chatId = chatOf(raw);
  const body = msg.body ?? "";
  const written = findCommand(body);
  const self = await selfIds();
  const users = self.map((id) => id.split("@")[0]!);
  const text = ownText(body, users);
  const ratio = written?.rest.match(RATIO)?.slice(1, 3).map(Number) as Ratio | undefined;
  if (written) return { command: written.command, text, ratio };
  const quotesAi = Boolean(raw.quotedStanzaID && wasSaid(chatId, raw.quotedStanzaID));
  const trivial = isNoise(text) && raw.type !== "image";
  const tagged = users.some((user) => body.includes(`@${user}`));
  const mentioned = tagged || msg.mentionedIds.some((id) => self.includes(widOf(id)));
  if (quotesAi && (!trivial || mentioned)) return { command: AI, text };
  if (!mentioned) return null;
  if (hasSource(raw, body, album)) return { command: STICKER, text };
  if (isNoise(text) && raw.quotedMsg?.type === "chat") return { command: STICKER, text };
  return { command: AI, text: isNoise(text) ? "" : text };
}
