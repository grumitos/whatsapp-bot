import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { oneLine, SILENCE, farewellNotice, memoryBlock, personaBlock } from "./prompts.ts";
import { userTurn, followUpTurn, type ChatLine } from "./prompts.ts";
import texts from "./prompts.json" with { type: "json" };
import { apiError, overBudget, promptTokens, reserve, searchesLeft, settle } from "./spend.ts";
import * as store from "./store.ts";
import { condense } from "./memory.ts";
import { toolResults } from "./tools.ts";

const MODEL = "claude-sonnet-5-5";

// El sistema, las herramientas, el pensamiento y el esfuerzo no cambian nunca: así vale la caché
const BASE = { model: MODEL, thinking: { type: "adaptive" }, output_config: { effort: "medium" } };
const MINUTE_MS = 60_000;
export const THREAD_IDLE_MS = 54 * MINUTE_MS;
export const EXCHANGE_MS = 3 * MINUTE_MS;
const COMPACT_TOKENS = 70_000;
const MAX_OUTPUT = 1500;
const DEADLINE_MS = 90_000;
const REPLY_MAX = 500;
export const RAW_MAX_AGE_MS = 24 * 60 * MINUTE_MS;
const RECENT_MS = 30 * MINUTE_MS;
const TOOLS = [texts.nameTool, texts.forgetTool] as Anthropic.Tool[];

const DOMAIN =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|me|co|pe|es|app|dev|xyz|link|ly|gl|to|info|ai|tv|gg|cc|ws|us|uk|ru|cn|top|site|online|shop|store|live|page|click|tk|ml|ga|cf|gq|be|gy|im|do)\b\S*/gi;

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Content = Anthropic.MessageParam["content"];
export type Image = { media_type: Anthropic.Base64ImageSource["media_type"]; data: string };
type Who = { chatId: string; phone: string; name: string; isOwner: boolean; uid: string };
type Said = { text?: string; quote?: { text: string; uid: string } | null; attachment?: string };

type Seen = {
  image?: Image | null;
  imageBy?: string;
  lines?: ChatLine[];
  msgId?: string;
  at?: number;
};

type Mode = { kind: "call" | "followup"; logged: boolean; last: boolean; directed?: boolean };
export type Job = Who & Said & Seen & Mode & { charged?: boolean; silent?: boolean };
type Times = { startedAt: number; lastAt: number; lastReplyAt: number | null };
type Counts = { size: number; turns: number; images: number; web: boolean; searchClosed?: boolean };
type People = { participants: { label: string; phone: string | null }[]; introduced: string[] };
type Talk = { addressed: { who: string; at: number }[]; farewelled?: boolean };
type Base = { chatId: string; cursor: number | null; messages: Anthropic.MessageParam[] };
export type Thread = Base & Times & Counts & People & Talk;

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const client = apiKey ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 }) : null;
export const threads = new Map<string, Thread>();
const locks = new Map<string, Promise<unknown>>();
const state = { checked: false, disabled: false, web: false, ttl: "1h" };

export const available = () => Boolean(client) && !state.disabled && config.ai !== null;
if (!client) log.warn("La IA está apagada: falta ANTHROPIC_API_KEY en .env.");

export function withLock<T>(chatId: string, task: () => Promise<T>) {
  const next = (locks.get(chatId) ?? Promise.resolve()).then(task);
  const tail = next.catch(() => undefined);
  locks.set(chatId, tail);
  void tail.then(() => locks.get(chatId) === tail && locks.delete(chatId));
  return next;
}

export async function check() {
  if (!client || state.checked || !config.ai) return;
  try {
    const model = await client.models.retrieve(MODEL);
    state.web = Boolean(model.capabilities?.server_tools?.web_search?.supported);
    state.checked = true;
    log.ok(`IA lista (${MODEL}; búsqueda web: ${state.web ? "sí" : "no"}).`);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0;
    if ([401, 403, 404].includes(status)) state.checked = state.disabled = true;
    const why =
      status === 404 ? `esta clave no tiene acceso a ${MODEL}` : "la API rechazó la clave";
    if (state.disabled) return log.error(`La IA queda apagada: ${why}. Revisa ANTHROPIC_API_KEY.`);
    log.once("check", `No se pudo comprobar la clave de la IA; se reintentará: ${apiError(err)}`);
  }
}

export const textOf = (content: Anthropic.ContentBlock[]) =>
  content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function finalText(content: Anthropic.ContentBlock[]) {
  const last = content.findLastIndex((b) => b.type !== "text" && b.type !== "thinking");
  return textOf(content.slice(last + 1)) || textOf(content);
}

// Lo que escribe el modelo nunca lleva enlaces, menciones ni comandos del bot
function cleanReply(text: string, botName?: string) {
  let reply = text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`/g, "")
    .replace(/<\/?[a-z_]+(?:\s[^>]*)?>/gi, "")
    .replace(/https?:\/\/\S+|\bwww\.\S+/gi, "")
    .replace(DOMAIN, "")
    .replace(/@\d{5,}/g, "")
    .replace(/!+(?=[\p{L}\p{N}#])/gu, "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#+\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .replace(/(?<!\.)\.$/, "");
  if (botName) reply = reply.replace(new RegExp(`^${escape(botName)}\\s*:\\s*`, "i"), "");
  if (reply.length <= REPLY_MAX) return reply;
  const cut = reply.slice(0, REPLY_MAX);
  const end = Math.max(...[". ", "? ", "! ", "\n"].map((mark) => cut.lastIndexOf(mark)));
  return end > REPLY_MAX / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

function dropVocative(reply: string, name: string) {
  const who = escape(name.replace(/\s*\(\d+\)$/, "").trim());
  if (!who || /^hola\b/i.test(reply)) return reply;
  let result = reply.replace(new RegExp(`,\\s*${who}(?=\\s*[.!?…]|\\s*$)`, "giu"), "");
  const leading = new RegExp(`^${who}\\s*,\\s*`, "iu");
  if (leading.test(result))
    result = result.replace(leading, "").replace(/^\p{Ll}/u, (l) => l.toUpperCase());
  return result.trim() || reply;
}

const webTool = (): Anthropic.WebSearchTool20250305 => ({
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 1,
  allowed_callers: ["direct"],
  user_location: { type: "approximate", country: config.ai?.country, timezone: config.timeZone },
});

export const cacheAlive = (thread: Thread) =>
  Date.now() - thread.lastAt < ((state.ttl === "5m" ? 5 : 60) - 2) * MINUTE_MS;

export async function create(thread: Thread, deadline: number, cacheThread = true) {
  const cache = { type: "ephemeral" as const, ...(state.ttl === "1h" && { ttl: "1h" as const }) };
  const system = [{ type: "text" as const, text: texts.system.join("\n"), cache_control: cache }];
  const tools = thread.web ? [...TOOLS, webTool()] : TOOLS;
  const own = cacheThread && { cache_control: cache };
  const { messages } = thread;
  const body = { ...BASE, max_tokens: MAX_OUTPUT, system, ...own, tools, messages };
  const usd = reserve(thread.size, MAX_OUTPUT);
  const signal = AbortSignal.timeout(Math.max(1000, deadline - Date.now()));
  try {
    const response = await client!.messages.create(body as Params, { signal });
    settle(usd, response.usage);
    return response;
  } catch (err) {
    settle(usd);
    const bad = err instanceof Anthropic.APIError && err.status === 400;
    if (!bad || !/ttl|cache_control/i.test(err.message) || state.ttl === "5m") throw apiError(err);
    state.ttl = "5m";
    log.warn("La caché de 1 hora no se aceptó; se usa la de 5 minutos", err);
    return create(thread, deadline, cacheThread);
  }
}

// Sin texto es un fallo que se reintenta: nunca se guarda un tramo vacío en la memoria
export async function oneShot(system: string, content: string, timeout = DEADLINE_MS) {
  const usd = reserve(content.length / 3, 2000);
  const body = { ...BASE, max_tokens: 2000, system, messages: [{ role: "user", content }] };
  const request = client!.messages.create(body as Params, { signal: AbortSignal.timeout(timeout) });
  const response = await request.finally(() => settle(usd));
  settle(0, response.usage);
  if (response.stop_reason === "refusal") throw new Error("la API rechazó el resumen");
  const text = textOf(response.content);
  if (!text.trim()) throw new Error(`la API no devolvió texto (${response.stop_reason})`);
  return text;
}

export function loadThread(chatId: string) {
  const saved = threads.get(chatId) ?? store.thread<Thread>(chatId);
  if (saved) threads.set(chatId, saved);
  return saved ?? null;
}

function keepThread(thread: Thread) {
  threads.set(thread.chatId, thread);
  store.saveThread(thread);
}

async function newThread(chatId: string): Promise<Thread> {
  if (config.ai?.webSearch) await check();
  const web = Boolean(config.ai?.webSearch && state.web && searchesLeft());
  const now = Date.now();
  const counts = { lastReplyAt: null, cursor: null, size: 0, turns: 0, images: 0, web };
  const lists = { addressed: [], participants: [], introduced: [], messages: [] };
  return { chatId, startedAt: now, lastAt: now, ...counts, ...lists };
}

export function sessionOpen(chatId: string) {
  const thread = loadThread(chatId);
  if (!thread?.lastReplyAt || thread.farewelled) return false;
  return Date.now() - thread.lastReplyAt <= 5 * MINUTE_MS;
}

function labelFor(thread: Thread, job: Job) {
  const base = oneLine(job.name || "Alguien", 30) || "Alguien";
  const known = thread.participants.find((p) => p.phone === job.phone);
  if (known) return known.label;
  let label = base;
  for (let n = 2; thread.participants.some((p) => p.label === label); n++) label = `${base} (${n})`;
  thread.participants.push({ label, phone: job.phone });
  return label;
}

// Manda el tiempo, no la cantidad de mensajes: el tope de caracteres solo cuida el gasto
function recentLines(job: Job, thread: Thread, now: number): ChatLine[] {
  if (!job.logged) return [];
  const until = job.at ?? now;
  const first = thread.cursor == null;
  const seen = store.chat(job.chatId).seenAt ?? 0;
  const window = first ? Math.max(until - RAW_MAX_AGE_MS, seen) : until - RECENT_MS;
  const since = Math.max(window, thread.cursor ?? 0);
  const fresh = (l: store.LogLine) => !l.bot && l.id !== job.msgId && l.t > since && l.t <= until;
  const kept: store.LogLine[] = [];
  let size = first ? 12_000 : 6_000;
  for (const line of store.readLog(job.chatId).filter(fresh).reverse()) {
    size -= line.text.length;
    if (size < 0) break;
    kept.unshift(line);
  }
  return kept.map((l) => ({ who: l.who || "Alguien", text: l.text, at: l.t }));
}

function quoteOf(job: Job) {
  if (!job.quote) return null;
  const log = job.logged && job.quote.uid ? store.readLog(job.chatId) : [];
  const who = log.findLast((line) => line.uid === job.quote?.uid)?.who ?? "";
  return { text: job.quote.text, who };
}

function turnFor(thread: Thread, job: Job, label: string, fresh: boolean) {
  const now = Date.now();
  const memory = fresh ? memoryBlock(store.chat(job.chatId), now) : null;
  if (job.kind === "followup") {
    const recent = job.logged ? recentLines(job, thread, now) : (job.lines ?? []);
    if (!recent.length && !job.image) return null;
    return followUpTurn({ now, memory, personas: [], recent }, Boolean(job.directed));
  }
  const notes = thread.introduced.includes(label) ? "" : store.user(job.chatId, job.phone).notes;
  const personas = notes ? [personaBlock(label, notes)] : [];
  const turn = { now, memory, personas, recent: recentLines(job, thread, now), label };
  const said = { text: job.text ?? "", quote: quoteOf(job), attachment: job.attachment };
  return userTurn({ ...turn, ...said });
}

async function answer(thread: Thread, job: Job, fresh: boolean): Promise<string | null> {
  const now = Date.now();
  const call = job.kind === "call";
  const before = thread.messages.length;
  const push = (role: Anthropic.MessageParam["role"], content: Content) =>
    thread.messages.push({ role, content });
  const label = labelFor(thread, job);
  const turn = turnFor(thread, job, label, fresh);
  if (turn === null) return null;
  const image = job.image && thread.images < 6 ? job.image : null;
  const by = `<imagen autor="${oneLine(job.imageBy || label, 30)}"/>`;
  const source = image && { type: "base64" as const, ...image };
  const parts: Anthropic.ContentBlockParam[] = [{ type: "text", text: turn }];
  if (source) parts.unshift({ type: "text", text: by }, { type: "image", source });
  push("user", source ? parts : turn);
  // Avisos del operador: sin búsquedas, el hilo conserva la herramienta (cambiarla rompe la caché)
  const closeSearch = thread.web && !thread.searchClosed && !searchesLeft();
  const farewell = config.ai?.farewell ?? "Adiós";
  const bye = job.last && farewellNotice(label, farewell, !call);
  const notices = [closeSearch && texts.noSearch, bye].filter(Boolean);
  if (closeSearch) thread.searchClosed = true;
  if (notices.length) push("system", notices.join("\n"));
  const rollback = () => {
    thread.messages.length = before;
    if (closeSearch) thread.searchClosed = false;
    return null;
  };
  try {
    const deadline = now + DEADLINE_MS;
    let response: Anthropic.Message;
    for (let round = 0; ; round++) {
      if (round > 3 || overBudget()) return rollback();
      response = await create(thread, deadline);
      job.charged = true;
      push("assistant", response.content as Anthropic.ContentBlockParam[]);
      thread.size = promptTokens(response.usage);
      if (response.stop_reason === "tool_use")
        push("user", toolResults(response.content, job, label));
      else if (response.stop_reason !== "pause_turn") break;
    }
    const cached = response.usage.cache_read_input_tokens ?? 0;
    log.info(`IA: ${thread.size} tokens de entrada (${cached} desde la caché)`);
    if (response.stop_reason === "refusal") return rollback();
    if (response.stop_reason === "max_tokens")
      log.warn(`La respuesta de la IA llegó al tope de ${MAX_OUTPUT} tokens.`);
    const raw = finalText(response.content);
    Object.assign(thread, {
      lastAt: now,
      cursor: Math.max(thread.cursor ?? 0, job.at ?? now),
      images: thread.images + (image ? 1 : 0),
    });
    const quiet = SILENCE.test(raw);
    if (quiet && !call) {
      job.silent = true;
      keepThread(thread);
      return null;
    }
    const chat = store.chat(job.chatId);
    let reply = quiet ? "" : cleanReply(raw, chat.name?.value);
    if (reply && thread.introduced.includes(label)) reply = dropVocative(reply, label);
    if (!reply && call) {
      log.warn("El modelo no escribió respuesta a una llamada; se envió solo un saludo.");
      reply = `Hola, ${label.replace(/\s*\(\d+\)$/, "")}`;
      thread.messages[thread.messages.length - 1] = { role: "assistant", content: reply };
    }
    if (!reply) return rollback();
    const end = escape(farewell.replace(/[.!]+$/, ""));
    const farewellEnd = new RegExp(`\\s*(?:adi[oó]s|${end})[.!]*\\s*$`, "i");
    if (job.last) reply = `${reply.replace(farewellEnd, "").trimEnd()} ${farewell}`;
    if (!thread.introduced.includes(label)) thread.introduced.push(label);
    const recent = thread.addressed.filter((p) => p.who !== job.phone && now - p.at <= EXCHANGE_MS);
    const done = { turns: thread.turns + 1, lastReplyAt: now, farewelled: job.last };
    Object.assign(thread, { ...done, addressed: [...recent, { who: job.phone, at: now }] });
    keepThread(thread);
    store.saveChat(job.chatId, { ...chat, usedAt: chat.usedAt ?? now, activeAt: now });
    const said = { t: Date.now(), who: chat.name?.value || "Bot", text: reply, bot: true };
    if (job.logged) store.appendLog(job.chatId, said);
    return reply;
  } catch (err) {
    rollback();
    throw err;
  }
}

async function converseLocked(job: Job) {
  const spent = "La IA llegó a su tope de gasto de hoy y no responde hasta mañana.";
  if (overBudget()) return log.once(`budget-${new Date().toDateString()}`, spent);
  const saved = loadThread(job.chatId);
  const stale = saved && Date.now() - saved.lastAt > THREAD_IDLE_MS;
  if (saved && (stale || saved.size > COMPACT_TOKENS)) await condense(saved);
  const fresh = !saved || stale || saved.size > COMPACT_TOKENS;
  const current = fresh ? await newThread(job.chatId) : saved;
  try {
    return await answer(current, job, fresh);
  } catch (err) {
    const message = String((err as Error).cause ?? err);
    // La API no pudo abrir la imagen (un sticker animado, por ejemplo): se sigue sin ella
    if (job.image && /400/.test((err as { code?: string }).code ?? "") && /image/i.test(message)) {
      job.image = null;
      job.attachment = job.kind === "followup" ? undefined : texts.unreadableImage;
      return answer(current, job, fresh);
    }
    // El pensamiento guardado va firmado con el prompt del sistema: con otro prompt, se descarta
    if (/signature/i.test(message)) {
      for (const m of current.messages)
        if (Array.isArray(m.content))
          m.content = m.content.filter((b) => !b.type.includes("thinking"));
      return answer(current, job, fresh);
    }
    if (!current.web || !/web.?search|server.?tool/i.test(message)) throw err;
    state.web = false;
    log.warn("La API rechazó la búsqueda web; queda desactivada", err);
    threads.delete(job.chatId);
    store.dropThread(job.chatId);
    return answer(await newThread(job.chatId), job, true);
  }
}

export function converse(job: Job) {
  if (!available()) return Promise.resolve(null);
  return withLock(job.chatId, () => converseLocked(job));
}
