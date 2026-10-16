import { log } from "../log.ts";
import { RAW_MAX_AGE_MS, THREAD_IDLE_MS, available, cacheAlive, create, loadThread } from "./ai.ts";
import { oneShot, textOf, threads, withLock, type Thread } from "./ai.ts";
import { chatBlock, digestInput, foldInput, oneLine, parseConsolidation } from "./prompts.ts";
import { parseDigest, parseFold, forgetText } from "./prompts.ts";
import texts from "./prompts.json" with { type: "json" };
import { overBudget } from "./spend.ts";
import * as store from "./store.ts";
import { liveForgotten, scrub } from "./tools.ts";

const DIGEST_EVERY_MS = 6 * 3_600_000;

// La última hora queda sin resumir: un hilo en curso aún puede no haberla visto
const MARGIN_MS = 3_600_000;
const MAX_FAILURES = 3;
const CHUNK_CHARS = 120_000;
type Digest = { boundary: number; text: string | null; foldFailures: number };
const pending = new Map<string, Digest>();
const failures = new Map<string, { count: number; until: number }>();
let ticking = false;

const participantOf = (thread: Thread, name: string) =>
  thread.participants.find((p) => p.label.toLowerCase() === name.trim().toLowerCase());

function remember(thread: Thread, text: string) {
  const parsed = parseConsolidation(text);
  const chat = store.chat(thread.chatId);
  for (const { phone, label, words } of liveForgotten(chat)) {
    parsed.group = forgetText(parsed.group, words, label);
    for (const [name, note] of parsed.people)
      if (participantOf(thread, name)?.phone === phone)
        parsed.people.set(name, words.length ? forgetText(note, words) : "");
  }
  if (parsed.group) chat.summary = oneLine(parsed.group, 900);
  // Lo que este hilo vio del chat ya quedó en la memoria: el siguiente empieza desde ahí
  chat.seenAt = Math.max(chat.seenAt ?? 0, thread.cursor ?? 0);
  store.saveChat(thread.chatId, chat);
  for (const [label, note] of parsed.people) {
    const person = participantOf(thread, label);
    if (!person?.phone || !note) continue;
    const names = [...new Set([person.label, ...store.user(thread.chatId, person.phone).names])];
    const user = { names: names.slice(0, 3), notes: oneLine(note, 700), at: Date.now() };
    store.saveUser(thread.chatId, person.phone, user);
  }
}

export async function condense(thread: Thread) {
  threads.delete(thread.chatId);
  try {
    if (thread.turns < 2 || overBudget()) return;
    thread.messages.push({ role: "user", content: texts.consolidation.join("\n") });
    const response = await create(thread, Date.now() + 90_000, cacheAlive(thread));
    if (response.stop_reason !== "refusal") remember(thread, textOf(response.content));
  } catch (err) {
    log.error("No se pudo guardar lo que se habló", err);
  } finally {
    store.dropThread(thread.chatId);
  }
}

function closeSpan(chatId: string, chat: store.Chat, boundary: number) {
  store.saveChat(chatId, { ...chat, digestAt: boundary });
  const kept = store.readLog(chatId).filter((line) => line.t > boundary);
  store.replaceLog(chatId, kept);
  pending.delete(chatId);
  failures.delete(chatId);
}

async function digestChat(chatId: string) {
  const ready = pending.get(chatId);
  if (ready) return commitDigest(chatId, ready);
  const now = Date.now();
  const boundary = now - MARGIN_MS;
  // Si los resúmenes fallan durante días, el chat guardado no crece sin fin
  const all = store.readLog(chatId).filter((line) => line.t <= now);
  const lines = all.slice(-4000);
  if (lines.length < all.length) store.replaceLog(chatId, lines);
  const chat = store.chat(chatId);
  const digestAt = chat.digestAt ?? lines[0]?.t ?? now;
  if (chat.digestAt == null) store.saveChat(chatId, { ...chat, digestAt });
  const used = Boolean(chat.usedAt || chat.name || chat.summary || chat.digests.length);
  const old = lines.filter((line) => line.t <= boundary);
  if (!used || boundary - digestAt < DIGEST_EVERY_MS || old.length < 6) {
    const fresh = lines.filter((line) => line.t > now - RAW_MAX_AGE_MS);
    if (fresh.length < lines.length) store.replaceLog(chatId, fresh);
    return;
  }
  const chunks: store.LogLine[][] = [[]];
  let size = 0;
  for (const line of old) {
    const fits = size + line.text.length + 40 <= CHUNK_CHARS;
    size = (fits ? size : 0) + line.text.length + 40;
    if (!fits) chunks.push([]);
    chunks.at(-1)!.push(line);
  }
  const system = texts.digest.join("\n");
  const parts: string[] = [];
  for (const chunk of chunks) parts.push(parseDigest(await oneShot(system, digestInput(chunk))));
  const joined =
    parts.length > 1 ? parseDigest(await oneShot(system, chatBlock(parts.join("\n")))) : parts[0]!;
  const text = /^nada importante/i.test(joined) ? null : joined;
  pending.set(chatId, { boundary, text, foldFailures: 0 });
  failures.delete(chatId);
  return commitDigest(chatId, pending.get(chatId)!);
}

// Guardar va bajo el candado del chat: no pisa una nota, un nombre ni algo que se pidió olvidar
function commitDigest(chatId: string, done: Digest) {
  return withLock(chatId, async () => {
    const chat = store.chat(chatId);
    const text = done.text ? scrub(chat, done.text) || null : null;
    const expiring = text && chat.digests.length >= 4 ? chat.digests[0] : null;
    let folded = "";
    try {
      const input = expiring && foldInput(chat.summary, expiring.text);
      const fold = input && (await oneShot(texts.fold.join("\n"), input, 30_000));
      if (fold) folded = scrub(chat, parseFold(fold));
    } catch (err) {
      if (++done.foldFailures < MAX_FAILURES) throw err;
      log.warn("No se pudo pasar un resumen que caducaba al resumen general", err);
    }
    const latest = store.chat(chatId);
    if (folded) latest.summary = folded;
    if (text) latest.digests = [...latest.digests, { at: done.boundary, text }].slice(-4);
    closeSpan(chatId, latest, done.boundary);
  });
}

async function digestSafely(chatId: string) {
  if ((failures.get(chatId)?.until ?? 0) > Date.now()) return;
  try {
    await digestChat(chatId);
  } catch (err) {
    const count = (failures.get(chatId)?.count ?? 0) + 1;
    failures.set(chatId, { count, until: Date.now() + 30 * 60_000 });
    log.error("No se pudo resumir el chat", err);
    if (count < MAX_FAILURES) return;
    closeSpan(chatId, store.chat(chatId), Date.now() - MARGIN_MS);
    log.warn("Se descartó un tramo del chat que no se pudo resumir.");
  }
}

async function closeIdle(chatId: string) {
  const thread = loadThread(chatId);
  if (thread && Date.now() - thread.lastAt >= THREAD_IDLE_MS) await condense(thread);
}

export async function tick(chatIds: string[]) {
  if (!available() || ticking) return;
  ticking = true;
  const fail = (err: unknown) => log.error("No se pudo cerrar una conversación", err);
  try {
    for (const chatId of new Set([...threads.keys(), ...store.threadIds()]))
      if (chatId) await withLock(chatId, () => closeIdle(chatId)).catch(fail);
    store.expire(Date.now());
    if (!overBudget()) for (const chatId of chatIds) await digestSafely(chatId);
  } finally {
    ticking = false;
  }
}
