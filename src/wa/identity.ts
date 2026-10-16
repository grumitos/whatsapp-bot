import type { Message } from "whatsapp-web.js";
import { normalizePhone } from "../config.ts";
import { log } from "../log.ts";
import { client, lidAndPhone, page } from "./client.ts";
import type { MediaData } from "./media.ts";

type Wid = string | { user: string; server: string } | undefined;
type Key = { fromMe: boolean; remote: Wid; id: string; participant?: Wid };
type Quote = { quotedMsg?: MediaData; quotedStanzaID?: string; quotedParticipant?: Wid };
export type Raw = MediaData & Quote & { id: Key; from: Wid; to: Wid; author?: Wid; t?: number };
export type Sender = { id: string; phone: string | null; key: string };

const LOOKUP_MS = 10_000;
const phones = new Map<string, string | null>();
let selfLid: string | undefined;

export const rawOf = (msg: Message) => msg.rawData as Raw & { parentMsgKey?: string | Key };

// Los ids de WhatsApp Web no traen _serialized: se arman con sus partes
export const widOf = (w: Wid) => (typeof w === "object" ? `${w.user}@${w.server}` : (w ?? ""));

export const messageId = ({ fromMe, remote, id, participant }: Key) =>
  [fromMe, widOf(remote), id, ...(participant ? [widOf(participant)] : [])].join("_");

export const chatOf = (raw: Raw) => widOf(raw.id.fromMe ? raw.to : raw.from);
export const isGroup = (chatId: string) => chatId.endsWith("@g.us");
export const selfId = () => `${client.info.wid.user}@c.us`;

// Un @lid se traduce a su número con plazo; un fallo no se guarda y se reintenta en el próximo
async function phoneOf(id: string) {
  if (!id.endsWith("@lid")) return id;
  if (phones.has(id)) return phones.get(id) ?? null;
  const lookup = lidAndPhone([id]).then(([found]) => found?.pn ?? null);
  const timeout = Bun.sleep(LOOKUP_MS).then(() => Promise.reject(new Error("sin respuesta")));
  try {
    phones.set(id, await Promise.race([lookup, timeout]));
  } catch (err) {
    log.warn(`No se pudo obtener el número de ${id}`, err);
  }
  return phones.get(id) ?? null;
}

export async function senderOf(raw: Raw): Promise<Sender> {
  const id = raw.id.fromMe ? selfId() : widOf(raw.author ?? raw.from);
  const phone = normalizePhone(await phoneOf(id)) || null;
  return { id, phone, key: phone ?? id };
}

export async function selfIds() {
  const lookup = () => lidAndPhone([selfId()]).then(([found]) => found?.lid);
  selfLid ??= await lookup().catch(
    (err) => void log.warn("No se pudo obtener el @lid del bot", err),
  );
  return [selfId(), selfLid].filter((id): id is string => Boolean(id));
}

export const namesOf = (ids: string[]) =>
  page().evaluate((ids) => {
    const { Contact } = window.require("WAWebCollections");
    const name = (c: ReturnType<typeof Contact.get>) => c?.name || c?.pushname || c?.verifiedName;
    return ids.map((id) => String(name(Contact.get(id)) || ""));
  }, ids);

export async function mentionNames(text: string) {
  const users = [...new Set(Array.from(text.matchAll(/@(\d{5,})/g), (match) => match[1]!))];
  const names = await namesOf(users.flatMap((user) => [`${user}@lid`, `${user}@c.us`]));
  return new Map(users.map((user, i) => [user, names[2 * i] || names[2 * i + 1] || ""]));
}
