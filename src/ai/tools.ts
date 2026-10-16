import type Anthropic from "@anthropic-ai/sdk";
import type { Job } from "./ai.ts";
import { forgetText, forgetWords, mentionsTopic, validName } from "./prompts.ts";
import texts from "./prompts.json" with { type: "json" };
import * as store from "./store.ts";

const FORGET_MS = 36 * 3_600_000;
const reply = texts.tools;
type Input = { accion?: string; nombre?: string; alcance?: string; tema?: string };

export const liveForgotten = (chat: store.Chat) =>
  chat.forgotten.filter((entry) => Date.now() - entry.at < FORGET_MS);

export const scrub = (chat: store.Chat, text: string) =>
  liveForgotten(chat).reduce((kept, { words, label }) => forgetText(kept, words, label), text);

// Las reglas del nombre son del código: solo quien lo puso (o un owner) aprueba el cambio pendiente
function nameTool(job: Job, input: Input, label: string) {
  const chat = store.chat(job.chatId);
  if (chat.nameChange && Date.now() - chat.nameChange.at > 24 * 3_600_000) chat.nameChange = null;
  const mayDecide = job.isOwner || chat.name?.by === job.phone;
  const save = (text: string) => {
    store.saveChat(job.chatId, chat);
    return text;
  };
  if (input.accion === "proponer") {
    const name = validName(input.nombre);
    if (!name) return reply.badName;
    if (chat.name?.value.toLowerCase() === name.toLowerCase()) return reply.sameName;
    const change = { value: name, by: job.phone, byLabel: label };
    if (!chat.name || mayDecide) {
      [chat.name, chat.nameChange] = [change, null];
      return save(`Hecho: ahora se llama ${name}.`);
    }
    if (chat.nameChange && chat.nameChange.by !== job.phone)
      return `Ya hay un cambio pendiente de ${chat.nameChange!.byLabel}: primero tiene que resolverse.`;
    chat.nameChange = { ...change, at: Date.now() };
    const wait = `Pendiente: el cambio solo se aplica si ${chat.name.byLabel}, quien le puso el nombre actual, lo aprueba.`;
    return save(wait);
  }
  if (input.accion !== "aprobar" && input.accion !== "rechazar") return reply.unknownAction;
  if (!chat.nameChange) return reply.noChange;
  if (!mayDecide) return `Solo ${chat.name?.byLabel ?? "quien le puso el nombre"} puede decidirlo.`;
  const pending = chat.nameChange.value;
  chat.nameChange = null;
  if (input.accion === "rechazar") return save(reply.rejected);
  const given = String(input.nombre ?? "");
  if (given.trim().toLowerCase() !== pending.toLowerCase())
    return `El cambio pendiente es a «${pending}»: vuelve a aprobar indicando ese nombre.`;
  chat.name = { ...chat.name!, value: pending };
  return save(`Hecho: ahora se llama ${pending}.`);
}

// Que proceda lo decide el modelo; el código solo quita texto de lo de quien lo pide
function forgetTool(job: Job, input: Input, label: string) {
  if (!job.phone) return reply.unknownPerson;
  const all = input.alcance === "todo";
  const words = all ? [] : forgetWords(input.tema);
  if (!all && !words.length) return reply.noTopic;
  const user = store.user(job.chatId, job.phone);
  const notes = all ? "" : forgetText(user.notes, words);
  let removed = notes !== user.notes;
  if (removed && notes) store.saveUser(job.chatId, job.phone, { ...user, notes, at: Date.now() });
  if (removed && !notes) store.removeUser(job.chatId, job.phone);
  const chat = store.chat(job.chatId);
  const summary = forgetText(chat.summary, words, label);
  const digests = chat.digests.map((d) => ({ ...d, text: forgetText(d.text, words, label) }));
  const kept = digests.filter((d) => d.text);
  removed ||= summary !== chat.summary || digests.some((d, n) => d.text !== chat.digests[n]?.text);
  const entry = { at: Date.now(), phone: job.phone, label, words };
  const forgotten = [...liveForgotten(chat), entry].slice(-20);
  store.saveChat(job.chatId, { ...chat, summary, digests: kept, forgotten });
  const log = store.readLog(job.chatId);
  const own = (line: store.LogLine) => !line.bot && line.uid === job.uid;
  const left = log.filter((line) => !own(line) || (!all && !mentionsTopic(line.text, words)));
  if (left.length !== log.length) store.replaceLog(job.chatId, left);
  return removed || left.length !== log.length ? reply.forgotten : reply.nothingForgotten;
}

export function toolResults(blocks: Anthropic.ContentBlock[], job: Job, label: string) {
  const run = (block: Anthropic.ToolUseBlock) => {
    const input = (block.input ?? {}) as Input;
    if (block.name === texts.nameTool.name) return nameTool(job, input, label);
    return block.name === texts.forgetTool.name ? forgetTool(job, input, label) : null;
  };
  const uses = blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return uses.map((block): Anthropic.ToolResultBlockParam => {
    const result = run(block);
    const base = { type: "tool_result" as const, tool_use_id: block.id };
    return { ...base, content: result ?? reply.unknownTool, is_error: result === null };
  });
}
