import { mock } from "bun:test";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "crypto";
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
type ModelEntry = {
  id: { fromMe: boolean; remote: Wid; id: string; participant?: Wid; toString?: () => string };
  t?: number;
  body?: string;
};
const wid = (user: string, server = "c.us") => ({
  user,
  server,
  toString: () => `${user}@${server}`,
});
const plain = (user: string, server = "c.us"): Wid => ({ user, server });
export const models: ModelEntry[] = [];
export const messageById = new Map<string, unknown>();
const find = (id: string) => PEOPLE.find((p) => id === `${p.lid}@lid` || id === `${p.phone}@c.us`);

export const uploads: { type: string; mediaKey: string }[] = [];
export const soundGating = {
  isSoundStickerConsumptionEnabled: () => false,
  isSoundStickerCreationEnabled: () => false,
  isSoundStickerPlaybackEnabled: () => false,
};

const modules: Record<string, unknown> = {
  WAWebMsgKey: class {},
  WAWebCollections: {
    Msg: {
      getModelsArray: () => models,
      get: (id: string) => messageById.get(id),
      getMessagesById: async (ids: string[]) => ({
        messages: ids.map((id) => messageById.get(id)).filter(Boolean),
      }),
    },
    Contact: { get: (id: string) => find(id) && { name: find(id)!.name } },
  },
  WAWebSoundStickerGating: soundGating,
  WAWebStickersGenerateStickerMessageProto: {},
  WAWebStartMediaUploadQpl: { startMediaUploadQpl: () => ({}) },
  WAWebUploadManager: {
    encryptAndUpload: async ({ type, mediaKey }: { type: string; mediaKey: string }) => {
      uploads.push({ type, mediaKey });
      return {
        url: "https://mmg.whatsapp.net/v/t62/audio-upload",
        directPath: "/v/t62/audio-upload",
        mediaKey,
        mediaKeyTimestamp: 1700000000,
        encFilehash: "encHash123",
      };
    },
  },
};

Object.assign(globalThis, {
  window: {
    crypto: globalThis.crypto,
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Módulo desconocido: ${name}`);
      return modules[name];
    },
    WWebJS: {
      enforceLidAndPnRetrieval: async (id: string) => {
        const found = find(id);
        return { lid: found && wid(found.lid, "lid"), phone: found && wid(found.phone) };
      },
      mediaInfoToFile: ({ data, mimetype }: { data: string; mimetype: string }) =>
        new File([Buffer.from(data, "base64")], "media", { type: mimetype }),
      getFileHash: async (file: File) =>
        createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("base64"),
    },
  },
});

type Sent = { chatId: string; content: unknown; options: Record<string, unknown> };
export const sent: Sent[] = [];
let sendFailure: { err: Error; onAttempt: number } | null = null;
let sendAttempt = 0;
export const failNextSend = (err: Error | null, onAttempt = 1) => {
  sendFailure = err && { err, onAttempt };
  sendAttempt = 0;
};

class Client {
  info = { wid: { user: BOT.phone } };
  pupPage = { evaluate: async (fn: Function, ...args: unknown[]) => fn(...args) };
  async sendMessage(chatId: string, content: unknown, options: Record<string, unknown>) {
    if (++sendAttempt === sendFailure?.onAttempt) {
      const { err } = sendFailure;
      sendFailure = null;
      throw err;
    }
    sent.push({ chatId, content, options });
    const [user, server] = chatId.split("@") as [string, string];
    const id = `BOT${++botCount}`;
    const remote = wid(user, server);
    const key = { fromMe: true, remote, id, $1: `true_${user}@${server}_${id}`, toString: () => key.$1 };
    models.push({
      id: key,
      t: Math.floor(Date.now() / 1000),
      body: typeof content === "string" ? content : "",
    });
    return { id: key };
  }
  async getMessageById(id: string) {
    return messageById.get(id) ?? null;
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

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9" +
    "awAAAABJRU5ErkJggg==",
  "base64",
);

function ffmpegBytes(args: string[]) {
  const res = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (res.exitCode !== 0) throw new Error(`ffmpeg setup falló: ${res.stderr.toString()}`);
  return Buffer.from(res.stdout);
}

export const SAMPLE_VIDEO = ffmpegBytes([
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=64x48:r=10:d=0.4",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=0.4",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-movflags",
  "frag_keyframe+empty_moov",
  "-f",
  "mp4",
  "pipe:1",
]);

export const SAMPLE_OPUS = ffmpegBytes([
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=520:duration=0.6",
  "-c:a",
  "libopus",
  "-f",
  "ogg",
  "pipe:1",
]);

const KEYS = {
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  ptt: "WhatsApp Audio Keys",
} as const;

function encrypted(type: keyof typeof KEYS, payload: Buffer, mimetype: string) {
  const mediaKey = randomBytes(32);
  const keys = Buffer.from(hkdfSync("sha256", mediaKey, "", KEYS[type], 112));
  const cipher = createCipheriv("aes-256-cbc", keys.subarray(16, 48), keys.subarray(0, 16));
  const file = Buffer.concat([cipher.update(payload), cipher.final(), randomBytes(10)]);
  const directPath = `/v/t62/${randomBytes(8).toString("hex")}`;
  serve(`https://mmg.whatsapp.net${directPath}`, () => new Response(file));
  return {
    directPath,
    mediaKey: mediaKey.toString("base64"),
    mimetype,
    type,
  };
}

let count = 0;
let botCount = 0;

type TestRaw = {
  id: { fromMe: boolean; remote: Wid; id: string; participant?: Wid };
  from: Wid;
  to: Wid;
  author?: Wid;
  t: number;
  body: string;
  type: string;
  directPath?: string;
  mediaKey?: string;
  mimetype?: string;
  quotedMsg?: TestRaw;
  quotedStanzaID?: string;
  quotedParticipant?: Wid;
};
type TestMessage = { rawData: TestRaw; body: string; mentionedIds: string[] };

type MsgOpts = {
  chat?: string;
  image?: boolean;
  video?: boolean;
  ptt?: boolean;
  quoted?: TestMessage;
};

export function message(
  by: Person,
  body: string,
  { chat = "", image = false, video = false, ptt = false, quoted }: MsgOpts = {},
): TestMessage {
  const author = plain(by.lid, "lid");
  const group = chat ? plain(chat.split("@")[0]!, "g.us") : undefined;
  const remote = group ?? author;
  const id = { fromMe: false, remote, id: `3A${++count}`, ...(group && { participant: author }) };
  const raw = { id, from: remote, to: plain(BOT.phone), author: group && author };
  const media = image
    ? encrypted("image", PNG, "image/png")
    : video
      ? encrypted("video", SAMPLE_VIDEO, "video/mp4")
      : ptt
        ? encrypted("ptt", SAMPLE_OPUS, "audio/ogg; codecs=opus")
        : { type: "chat" };
  const quote = quoted
    ? {
        quotedMsg: quoted.rawData,
        quotedStanzaID: quoted.rawData.id.id,
        quotedParticipant: quoted.rawData.author ?? quoted.rawData.from,
      }
    : {};
  const rawData: TestRaw = { ...raw, t: Math.floor(Date.now() / 1000), body, ...media, ...quote };
  return { rawData, body, mentionedIds: [] };
}

export function lastBot(): TestMessage {
  const entry = models.at(-1)!;
  const id = entry.id;
  const rawData: TestRaw = {
    id,
    from: plain(BOT.phone),
    to: plain(id.remote.user, id.remote.server),
    t: entry.t ?? Math.floor(Date.now() / 1000),
    body: entry.body ?? "",
    type: "chat",
  };
  return { rawData, body: rawData.body ?? "", mentionedIds: [] };
}

export function queueMissed(msg: TestMessage) {
  const { id, t, body } = msg.rawData;
  const fullId = [
    id.fromMe,
    `${id.remote.user}@${id.remote.server}`,
    id.id,
    ...(id.participant ? [`${id.participant.user}@${id.participant.server}`] : []),
  ].join("_");
  messageById.set(fullId, msg);
  models.push({
    id: { ...id, toString: () => fullId },
    t,
    body,
  });
  return fullId;
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
