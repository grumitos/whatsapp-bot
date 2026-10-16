import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../config.ts";
import { appendLine, readJson, writeJson, writeText } from "../store.ts";
import { oneLine } from "./prompts.ts";

// Las rutas salen de ids que ya conoce el bot: nada de lo que escribe la gente llega a un nombre
const DIR = join(DATA_DIR, "ai");
const DAY_MS = 86_400_000;
const key = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
const file = (folder: string, id: string, ext = "json") => join(DIR, folder, `${key(id)}.${ext}`);
const userFile = (chatId: string, phone: string) => file("users", `${key(chatId)}__${key(phone)}`);
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const logFile = (chatId: string) => file("chats", chatId, "log");
const THREADS = join(DIR, "threads");
const remove = (path: string) => rmSync(path, { recursive: true, force: true });

type Name = { value: string; by: string | null; byLabel: string };
type Forgotten = { at: number; phone: string; label: string; words: string[] };
type Dates = Partial<Record<"usedAt" | "seenAt" | "activeAt", number>>;
type Memory = { summary: string; digests: { at: number; text: string }[]; digestAt: number | null };
export type Chat = Dates & Memory & { name: Name | null; forgotten: Forgotten[] };
export type ChatState = Chat & { nameChange?: (Name & { at: number }) | null };
export type User = { names: string[]; notes: string; at?: number };
export type LogLine = { t: number; who: string; text: string } & Partial<Line>;
type Line = { id: string; uid: string; bot: boolean };
type Saved = { chatId: string; messages: Anthropic.MessageParam[] };

const EMPTY = { name: null, summary: "", digests: [], digestAt: null, forgotten: [] };
export const chat = (id: string): ChatState => ({ ...EMPTY, ...readJson(file("chats", id), {}) });
export const saveChat = (chatId: string, value: Chat) => writeJson(file("chats", chatId), value);

export const user = (chatId: string, phone: string) =>
  readJson<User>(userFile(chatId, phone), { names: [], notes: "" });

export const saveUser = (chatId: string, phone: string, value: User) =>
  writeJson(userFile(chatId, phone), value);

export const removeUser = (chatId: string, phone: string) => remove(userFile(chatId, phone));

export const thread = <T extends Saved>(chatId: string) =>
  readJson<T | null>(file("threads", chatId), null);

export const saveThread = (thread: Saved) => writeJson(file("threads", thread.chatId), thread);

export const dropThread = (chatId: string) => remove(file("threads", chatId));

export const threadIds = () =>
  list(THREADS).map((name) => readJson<Saved | null>(join(THREADS, name), null)?.chatId);

export const appendLog = (chatId: string, line: LogLine) => appendLine(logFile(chatId), line);

export function record(
  chatId: string,
  line: { id: string; uid: string; name: string; text: string; at: number },
) {
  const text = oneLine(line.text, 400);
  const who = oneLine(line.name || "Alguien", 30);
  if (text) appendLog(chatId, { t: line.at, id: line.id, uid: line.uid, who, text });
}

export function readLog(chatId: string): LogLine[] {
  const target = logFile(chatId);
  const parse = (line: string) => {
    try {
      return [JSON.parse(line) as LogLine];
    } catch {
      return [];
    }
  };
  return existsSync(target) ? readFileSync(target, "utf8").split("\n").flatMap(parse) : [];
}

export function replaceLog(chatId: string, lines: LogLine[]) {
  if (!lines.length) return rmSync(logFile(chatId), { force: true });
  writeText(logFile(chatId), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

export type Spend = { day: string; usd: number; searches: number };
export const spend = () => readJson<Spend | null>(join(DIR, "spend.json"), null);
export const saveSpend = (value: Spend) => writeJson(join(DIR, "spend.json"), value);

type Said = { id: string; at: number };

const said = (chatId: string) =>
  readJson<Said[]>(file("said", chatId), []).filter((e) => Date.now() - e.at < 7 * DAY_MS);

export const addSaid = (chatId: string, id: string) =>
  writeJson(file("said", chatId), [...said(chatId), { id, at: Date.now() }].slice(-500));

export const wasSaid = (chatId: string, stanzaId: string) =>
  said(chatId).some((e) => e.id.split("_")[2] === stanzaId);

export function expire(now: number) {
  for (const name of list(join(DIR, "users"))) {
    const at = readJson<User>(join(DIR, "users", name), { names: [], notes: "" }).at ?? now;
    if (now - at > 90 * DAY_MS) remove(join(DIR, "users", name));
  }
  for (const id of list(join(DIR, "chats")).filter((name) => name.endsWith(".json"))) {
    const memory = chat(id.slice(0, -5));
    const active = Math.max(memory.activeAt ?? 0, memory.digestAt ?? 0) || now;
    if (memory.summary && now - active > 90 * DAY_MS)
      saveChat(id.slice(0, -5), { ...memory, summary: "" });
  }
}
