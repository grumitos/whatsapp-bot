import { mock } from "bun:test";
import { createCipheriv, hkdfSync, randomBytes } from "crypto";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Solo se simula lo que el bot no controla: WhatsApp Web, internet y la API de Anthropic.
// Va antes de importar el bot: el cliente de la IA se crea al importarlo
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
const DATA = join(tmpdir(), "wa-bot-v3-e2e");
rmSync(DATA, { recursive: true, force: true });

type Person = { phone: string; lid: string; name: string };
const person = (n: number, name: string): Person => ({
  phone: `521555000000${n}`,
  lid: `10000000000000${n}`,
  name,
});
const BOT = person(9, "Bot");
export const FRIEND = person(2, "Amigo");
export const STRANGER = person(3, "Extraño");
export const BLOCKED = person(4, "Bloqueado");
const PEOPLE = [BOT, FRIEND, STRANGER, BLOCKED];
export const GROUP = "120363000000001@g.us";

const CONFIG = {
  dataDir: DATA,
  timeZone: "America/Lima",
  locale: "es",
  allowedGroups: { [GROUP]: { members: "everyone", people: { [BLOCKED.phone]: "block" } } },
  ai: { dailyBudgetUsd: 1 },
};

// En la página los ids son objetos con toString; en rawData llegan planos y sin _serialized
type Wid = { user: string; server: string };
const wid = (user: string, server = "c.us") => ({
  user,
  server,
  toString: () => `${user}@${server}`,
});
const plain = (user: string, server = "c.us"): Wid => ({ user, server });
const models: { id: { fromMe: boolean; remote: Wid; id: string } }[] = [];
const find = (id: string) => PEOPLE.find((p) => id === `${p.lid}@lid` || id === `${p.phone}@c.us`);

const modules: Record<string, unknown> = {
  WAWebCollections: {
    Msg: { getModelsArray: () => models },
    Contact: { get: (id: string) => find(id) && { name: find(id)!.name } },
  },
};

Object.assign(globalThis, {
  window: {
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Módulo desconocido: ${name}`);
      return modules[name];
    },
    WWebJS: {
      enforceLidAndPnRetrieval: async (id: string) => {
        const found = find(id);
        return { lid: found && wid(found.lid, "lid"), phone: found && wid(found.phone) };
      },
    },
  },
});

type Sent = { chatId: string; content: unknown; options: Record<string, unknown> };
export const sent: Sent[] = [];

// Lo enviado queda en la página como mensaje propio: de ahí lee el bot su id
class Client {
  info = { wid: { user: BOT.phone } };
  pupPage = { evaluate: async (fn: Function, ...args: unknown[]) => fn(...args) };
  async sendMessage(chatId: string, content: unknown, options: Record<string, unknown>) {
    sent.push({ chatId, content, options });
    const [user, server] = chatId.split("@") as [string, string];
    models.push({ id: { fromMe: true, remote: wid(user, server), id: `BOT${models.length}` } });
  }
  on() {}
  once() {}
}

class MessageMedia {
  constructor(
    public mimetype: string,
    public data: string,
  ) {}
}

mock.module("whatsapp-web.js", () => ({ default: { Client, LocalAuth: class {}, MessageMedia } }));

// Sin red real: lo que no tiene una respuesta definida falla
export const requests: string[] = [];
const routes = new Map<string, () => Response>();
export const serve = (prefix: string, reply: () => Response) => routes.set(prefix, reply);

const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(`${init?.method ?? "GET"} ${url}`);
  const reply = [...routes].find(([prefix]) => url.startsWith(prefix))?.[1];
  if (!reply) throw new Error(`Sin red en las pruebas: ${url}`);
  return reply();
};
Object.assign(globalThis, { fetch: fakeFetch });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9" +
    "awAAAABJRU5ErkJggg==",
  "base64",
);

function encrypted() {
  const mediaKey = randomBytes(32);
  const keys = Buffer.from(hkdfSync("sha256", mediaKey, "", "WhatsApp Image Keys", 112));
  const cipher = createCipheriv("aes-256-cbc", keys.subarray(16, 48), keys.subarray(0, 16));
  const file = Buffer.concat([cipher.update(PNG), cipher.final(), randomBytes(10)]);
  const directPath = `/v/t62/${randomBytes(8).toString("hex")}`;
  serve(`https://mmg.whatsapp.net${directPath}`, () => new Response(file));
  return {
    directPath,
    mediaKey: mediaKey.toString("base64"),
    mimetype: "image/png",
    type: "image",
  };
}

let count = 0;

export function message(by: Person, body: string, { chat = "", image = false } = {}) {
  const author = plain(by.lid, "lid");
  const group = chat ? plain(chat.split("@")[0]!, "g.us") : undefined;
  const remote = group ?? author;
  const id = { fromMe: false, remote, id: `3A${++count}`, ...(group && { participant: author }) };
  const raw = { id, from: remote, to: plain(BOT.phone), author: group && author };
  const media = image ? encrypted() : { type: "chat" };
  const rawData = { ...raw, t: Math.floor(Date.now() / 1000), body, ...media };
  return { rawData, body, mentionedIds: [] };
}

const realLog = await import("../src/log.ts");
export const errors: string[] = [];
const quiet = () => null;
const error = (text: string, err?: unknown) =>
  void errors.push(err ? `${text}: ${realLog.errorDetail(err)}` : text);
const log = {
  title: quiet,
  info: quiet,
  ok: quiet,
  warn: quiet,
  reveal: quiet,
  once: quiet,
  error,
};
mock.module("../src/log.ts", () => ({ ...realLog, log }));

// Solo config.json es el de las pruebas; los demás archivos van a la carpeta temporal.
// La función real se guarda antes: tras el mock, el módulo importado apunta al reemplazo
const realStore = await import("../src/store.ts");
const realRead = realStore.readJson;
const readJson = <T,>(file: string, fallback: T) =>
  file.endsWith("config.json") ? (CONFIG as T) : realRead(file, fallback);
mock.module("../src/store.ts", () => ({ ...realStore, readJson }));
