import { join } from "path";
import { DATA_DIR, config, type Limit } from "../config.ts";
import { readJson, writeJson } from "../store.ts";
import type { Sender } from "../wa/identity.ts";
import { isOwner, personRule } from "./access.ts";

export type Use = "replies" | "conversation";
export type Taken = { keys: string[]; last: boolean };
type Window = { start: number; count: number };
const FILE = join(DATA_DIR, "quotas.json");
const usage = readJson<Record<string, Window>>(FILE, {});
const save = () => writeJson(FILE, usage);

function limitsOf(use: Use, chatId: string, sender: Sender) {
  const group = config.groups.get(chatId)?.limits ?? {};
  const chatUse = use === "replies" ? "chatReplies" : "chatConversation";
  const person = personRule(chatId, sender)[use] ?? group[use] ?? config.limits[use];
  const chat = group[chatUse] ?? config.limits[chatUse];
  const all: [string, Limit | undefined][] = [
    [`${use}:${chatId}:${sender.key}`, person],
    [`${use}:${chatId}`, chat],
  ];
  return all.flatMap(([key, limit]) => (limit && limit !== "unlimited" ? [{ key, ...limit }] : []));
}

export function take(
  use: Use,
  chatId: string,
  sender: Sender,
): Taken | { resetAt: Date; hours: number } {
  if (isOwner(sender)) return { keys: [], last: false };
  const now = Date.now();
  const windows = limitsOf(use, chatId, sender).map(({ key, max, hours }) => {
    const end = (usage[key]?.start ?? 0) + hours * 3_600_000;
    if (now >= end) usage[key] = { start: now, count: 0 };
    return {
      key,
      max,
      hours,
      entry: usage[key]!,
      resetAt: new Date(usage[key]!.start + hours * 3_600_000),
    };
  });
  const full = windows.find(({ entry, max }) => entry.count >= max);
  if (full) return { resetAt: full.resetAt, hours: full.hours };
  windows.forEach(({ entry }) => entry.count++);
  save();
  return {
    keys: windows.map(({ key }) => key),
    last: windows.some(({ entry, max }) => entry.count >= max),
  };
}

export function refund({ keys }: Taken) {
  for (const key of keys) if (usage[key]?.count) usage[key].count--;
  if (keys.length) save();
}

export function limitNotice({ resetAt, hours }: { resetAt: Date; hours: number }) {
  const options = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: config.timeZone,
  } as const;
  const format = new Intl.DateTimeFormat(config.locale, options);
  const hour = format.formatToParts(resetAt).find((part) => part.type === "hour")?.value;
  const at = `${hour === "1" ? "a la" : "a las"} ${format.format(resetAt)}`;
  return `Límite de ${hours} ${hours === 1 ? "hora" : "horas"} alcanzado ∙ se reinicia ${at}`;
}
