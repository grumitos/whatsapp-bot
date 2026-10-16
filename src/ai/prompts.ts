import { normalize as plain } from "../bot/commands.ts";
import { config } from "../config.ts";
import texts from "./prompts.json" with { type: "json" };
import type { ChatState } from "./store.ts";

export const SILENCE = /^\s*\[?\s*silencio\s*\]?\s*[.!]?\s*$/i;
const BLOCKED = new RegExp(`^(?:${texts.blockedNames.join("|")})$`);
const NAME = /^[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N} _.'-]{0,18}[\p{Script=Latin}\p{N}]$/u;
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i" };
const HOUR_MS = 3_600_000;
const TIME = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
const DATE = { weekday: "long", day: "numeric", month: "long", ...TIME } as const;

export type ChatLine = { who: string; text: string; at?: number };
type Turn = { now: number; memory: string | null; personas: string[]; recent: ChatLine[] };
type Call = Turn & { label: string; text: string; quote?: ChatLine | null; attachment?: string };

// Todo texto de la gente va escapado: sin "<" ni ">" ni sus parecidos, sin control ni teléfonos
export function clean(text: unknown, max: number) {
  const safe = String(text ?? "")
    .normalize("NFKC")
    .replace(/[\r\u0085\p{Zl}\p{Zp}]/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}\p{Variation_Selector}]/gu, "")
    .replace(/[<〈〈⟨❮﹤]/g, "‹")
    .replace(/[>〉〉⟩❯﹥]/g, "›")
    .replace(/"/g, "'")
    .replace(/@\d{5,}/g, "@alguien")
    .replace(/\+?\d(?:[ -]?\d){8,}/g, "[número]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

export const oneLine = (text: unknown, max: number) => clean(text, max).replace(/\s*\n\s*/g, " ");

const skeleton = (text: string) =>
  plain(text)
    .replace(/[013457@$!]/g, (symbol) => LEET[symbol as keyof typeof LEET])
    .replace(/[^a-z]/g, "")
    .replace(/([aeiou])\1+/g, "$1")
    .replace(/(.)\1{2,}/g, "$1");

export function validName(name: unknown) {
  const raw = String(name ?? "");
  const candidate = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  const parts = [candidate, ...candidate.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_.'-]+/)];
  return NAME.test(candidate) && !parts.some((p) => BLOCKED.test(skeleton(p))) ? candidate : null;
}

export function forgetWords(topic: unknown) {
  const words = plain(String(topic ?? "")).split(/[^a-z0-9]+/);
  return words.filter((w) => w.length >= 3 && !texts.stopwords.includes(w)).slice(0, 6);
}

const hasWord = (haystack: string, word: string, whole = false) =>
  !whole && word.length >= 4
    ? haystack.includes(word)
    : new RegExp(`(?:^|[^a-z0-9])${word}(?:[^a-z0-9]|$)`).test(haystack);

export const mentionsTopic = (text: unknown, words: string[]) =>
  words.some((w) => hasWord(plain(String(text ?? "")), w));

export function forgetText(text: unknown, words: string[] = [], mention = "") {
  const who = plain(oneLine(mention, 30)).match(/[a-z0-9]+/)?.[0];
  const unknown = mention.trim() && (!who || /\(\d+\)\s*$/.test(mention));
  if ((!words.length && !who) || unknown) return String(text ?? "");
  const aboutWho = (s: string) => !who || hasWord(s, who, true);
  const aboutTopic = (s: string) => !words.length || words.some((w) => hasWord(s, w));
  const sentences = String(text ?? "").split(/(?<=[.!?;])\s+/);
  const kept = sentences.filter((s) => !(aboutWho(plain(s)) && aboutTopic(plain(s))));
  return kept.join(" ").trim();
}

const format = (options: Intl.DateTimeFormatOptions, t: number) =>
  new Intl.DateTimeFormat(config.locale, { ...options, timeZone: config.timeZone }).format(t);

function ago(ms: number) {
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 1) return "menos de una hora";
  return hours < 36 ? `${hours} h` : `${Math.round(hours / 24)} días`;
}

export function memoryBlock(chat: ChatState, now: number) {
  const name = oneLine(chat.name?.value, 20);
  const by = oneLine(chat.name?.byLabel, 30);
  const lines = [name ? `Tu nombre en este grupo es ${name} (te lo puso ${by}).` : ""];
  if (!name) lines[0] = "Todavía no tienes nombre en este grupo.";
  const change = chat.nameChange;
  const proposer = oneLine(change?.byLabel, 30);
  const proposed = oneLine(change?.value, 20);
  const pending = `${proposer} propone «${proposed}» y tiene que aprobarlo ${by}.`;
  if (change) lines.push(`Cambio de nombre pendiente: ${pending}`);
  if (chat.summary) lines.push(`Del grupo recuerdas: ${oneLine(chat.summary, 900)}`);
  if (chat.digests.length) lines.push("Lo último que pasó, del más antiguo al más reciente:");
  for (const { at, text } of chat.digests)
    lines.push(`- hace ${ago(now - at)}: ${oneLine(text, 800)}`);
  return `<memoria>\n${texts.textNotice}\n${lines.join("\n")}\n</memoria>`;
}

export const personaBlock = (label: string, notes: string) =>
  `<persona nombre="${oneLine(label, 30)}">${texts.textNotice} ${oneLine(notes, 700)}</persona>`;

function chatLines(lines: ChatLine[], now: number) {
  const age = (at?: number) => (at != null && now - at > HOUR_MS ? `(hace ${ago(now - at)}) ` : "");
  const line = ({ who, text, at }: ChatLine) =>
    `${age(at)}${oneLine(who, 30)}: ${oneLine(text, 200)}`;
  return lines.map(line).join("\n");
}

const head = (turn: Turn) => [`<hora>${format(DATE, turn.now)}</hora>`, turn.memory ?? ""];

export function userTurn(call: Call) {
  const { recent, quote, attachment, label, text, now } = call;
  const parts = [...head(call), ...call.personas];
  if (recent.length) parts.push(`<chat_reciente>\n${chatLines(recent, now)}\n</chat_reciente>`);
  const author = quote?.who ? ` autor="${oneLine(quote.who, 30)}"` : "";
  if (quote) parts.push(`<cita${author}>${clean(quote.text, 400)}</cita>`);
  if (attachment) parts.push(`<adjunto>${oneLine(attachment, 60)}</adjunto>`);
  const body = clean(text, 600) || "(sin texto)";
  parts.push(`<mensaje autor="${oneLine(label, 30)}" llamada="si">${body}</mensaje>`);
  return parts.filter(Boolean).join("\n");
}

// directed lo pone el código cuando lo nombran o citan algo suyo, nunca el texto de la gente
export function followUpTurn(turn: Turn, directed: boolean) {
  const open = `<chat_nuevo${directed ? ' dirigido="si"' : ""}>`;
  const lines = `${open}\n${chatLines(turn.recent, turn.now)}\n</chat_nuevo>`;
  return [...head(turn), lines].filter(Boolean).join("\n");
}

export function farewellNotice(label: string, farewell: string, followUp: boolean) {
  const last = `Esta es tu última intervención con ${oneLine(label, 30)} por ahora: `;
  const group = "Si respondes a este mensaje, será tu última intervención en el grupo por ahora: ";
  const start = followUp ? group : last;
  const close = "cierra la charla con naturalidad, sin hacer preguntas ni dar motivos";
  const end = `termina el mensaje exactamente con «${farewell}»`;
  return `${start}responde a lo que escribieron y ${close}, y ${end}`;
}

export function parseConsolidation(text: string) {
  const entries: { person?: string; group: boolean; text: string }[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:(GRUPO|RESUMEN)|PERSONA\s+(.+?))\s*:\s*(.*)$/i.exec(line);
    const person = match?.[2]?.replace(/^["«']|["»']$/g, "");
    const extra = !match && line.trim() && !/^\s*NADA\s*$/i.test(line) && entries.at(-1);
    if (match) entries.push({ person, group: /grupo/i.test(match[1] ?? ""), text: match[3]! });
    if (extra) extra.text += ` ${line.trim()}`;
  }
  const people = entries.flatMap(({ person, text }) => (person ? [[person, text.trim()]] : []));
  const group = entries.findLast((entry) => entry.group)?.text.trim() ?? "";
  return { group, people: new Map(people as [string, string][]) };
}

export const chatBlock = (body: string) => `${texts.chatNotice}\n<chat>\n${body}\n</chat>`;

export function digestInput(lines: { t: number; who: string; text: string }[]) {
  const line = ({ t, who, text }: (typeof lines)[number]) =>
    `[${format(TIME, t)}]${oneLine(who, 30)}: ${oneLine(text, 400)}`;
  return chatBlock(lines.map(line).join("\n"));
}

export const parseDigest = (text: string) =>
  oneLine(text.replace(/^[\s\S]*?RESUMEN\s*:/i, ""), 800);

export function foldInput(summary: string, expiring: string) {
  const current = `<resumen_general>${oneLine(summary || "(vacío)", 900)}</resumen_general>`;
  const old = `<resumen_que_caduca>${oneLine(expiring, 800)}</resumen_que_caduca>`;
  return `${texts.foldNotice}\n${current}\n${old}`;
}

export const parseFold = (text: string) => oneLine(text.replace(/^[\s\S]*?GRUPO\s*:/i, ""), 900);
