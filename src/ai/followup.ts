import type { Message } from "whatsapp-web.js";
import { isOwner } from "../bot/access.ts";
import { reply, type Request } from "../bot/actions.ts";
import { isNoise, type Route } from "../bot/route.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { mentionNames, namesOf, selfId, widOf, type Raw, type Sender } from "../wa/identity.ts";
import { download, imageType, type MediaData } from "../wa/media.ts";
import { EXCHANGE_MS, available, converse, escape, loadThread, sessionOpen } from "./ai.ts";
import type { Image, Job } from "./ai.ts";
import * as store from "./store.ts";

const word = (w: string) => new RegExp(`(?:^|[^\\p{L}])${w}(?:[^\\p{L}]|$)`, "iu");
const FOLLOW: Route = { command: { kind: "conversation" }, text: "" };
const evals = new Map<string, number[]>();
type Item = { msg: Message; raw: Raw; sender: Sender };
type Batch = { items: Item[]; timer?: Timer; directed: boolean };
const batches = new Map<string, Batch>();

export async function loadImage(data: MediaData): Promise<Image | null> {
  const warn = (err: unknown) => log.warn("No se pudo descargar la imagen para la IA", err);
  const media = await download(data).catch(warn);
  if (!media || media.data.length > 4 * 1024 * 1024) return null;
  return { media_type: imageType(data)!, data: media.data.toString("base64") };
}

export async function withNames(text: string) {
  const names = await mentionNames(text);
  const named = (_: string, user: string) => (names.has(user) ? `@${names.get(user)}` : "");
  return text.replace(/@(\d{5,})/g, named);
}

export function maybeFollowUp(msg: Message, raw: Raw, sender: Sender, chatId: string) {
  const text = msg.body ?? "";
  // Citar al bot es citar algo que envió la IA, no un mensaje propio: el dueño usa el mismo número
  const quotesBot = Boolean(raw.quotedStanzaID && store.wasSaid(chatId, raw.quotedStanzaID));
  const empty = isNoise(text) && !(quotesBot && imageType(raw));
  if (!available() || !sessionOpen(chatId) || empty) return;
  const name = store.chat(chatId).name?.value;
  const named = Boolean(name) && word(escape(name!)).test(text);
  const near = ({ who, at }: { who: string; at: number }) =>
    who === sender.key && Date.now() - at <= EXCHANGE_MS;
  const exchange = loadThread(chatId)!.addressed.some(near);
  const directed = quotesBot || (!exchange && (word("bot").test(text) || named));
  const recent = (evals.get(chatId) ?? []).filter((at) => Date.now() - at < 3_600_000);
  if ((!directed && !exchange && !/[?¿]/.test(text)) || recent.length >= 20) return;
  evals.set(chatId, [...recent, Date.now()]);
  const batch = batches.get(chatId) ?? { items: [], directed: false };
  batch.items.push({ msg, raw, sender });
  batch.directed ||= directed;
  batches.set(chatId, batch);
  const fail = (err: unknown) => log.error("No se pudo atender un mensaje del chat", err);
  const flush = () => {
    clearTimeout(batch.timer);
    batches.delete(chatId);
    runFollowUp(chatId, batch).catch(fail);
  };
  if (quotesBot) return flush();
  batch.timer ??= setTimeout(flush, 4000);
}

const authorOf = (raw: Raw) => (raw.id.fromMe ? selfId() : widOf(raw.author ?? raw.from));

async function runFollowUp(chatId: string, { items, directed }: Batch) {
  const req: Request = { ...items.at(-1)!, chatId, route: FOLLOW };
  const said = items.filter(({ msg }) => msg.body?.trim());
  const names = await namesOf(said.map(({ raw }) => authorOf(raw)));
  const texts = await Promise.all(said.map(({ msg }) => withNames(msg.body)));
  const lines = said.map((_, i) => ({ who: names[i] || "Alguien", text: texts[i]! }));
  const withImage = items.findLast(({ raw }) => imageType(raw));
  const image = withImage ? await loadImage(withImage.raw) : null;
  const [imageBy] = withImage ? await namesOf([authorOf(withImage.raw)]) : [];
  return talk(req, { kind: "followup", directed, lines, image, imageBy });
}

export async function talk(req: Request, fields: Partial<Job> & Pick<Job, "kind">) {
  const off =
    "Alguien pidió la conversación con la IA, pero está apagada (el motivo está en el aviso del arranque).";
  if (!available()) return log.once("off", off);
  const { chatId, sender, raw } = req;
  const [name = ""] = await namesOf([sender.id]);
  const uid = raw.id.fromMe ? "yo" : sender.id;
  const who = { chatId, phone: sender.key, name, isOwner: isOwner(sender), uid };
  const job: Job = { ...who, logged: config.groups.has(chatId), last: false, ...fields };
  // Si la API ya respondió, el cupo se queda aunque no haya nada que enviar, salvo que callara
  const answer = async (last: boolean) => {
    job.last = last;
    const text = await converse(job).catch((err) => {
      if (job.charged) req.noRefund = true;
      throw err;
    });
    if (text == null && job.charged && !job.silent) req.noRefund = true;
    return text;
  };
  return reply(req, "conversation", answer, {}, (id) => id && store.addSaid(chatId, id));
}
