import { appendFileSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (style: string, s: string) => (color && style ? `\x1b[${style}m${s}\x1b[0m` : s);
let logDay = "";
let dataDir = "data";
const warned = new Set<string>();
export const setDataDir = (dir: string) => (dataDir = dir);

export const botError = (code: string, message: string, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { name: "BotError", code });

export function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, status } = err as { code?: unknown; status?: unknown };
  const head = [err.name, code != null && `[${code}]`, status != null && `HTTP ${status}`];
  const title = head.filter(Boolean).join(" ");
  const cause = err.cause ? ` (causa: ${errorDetail(err.cause)})` : "";
  return `${err.message ? `${title}: ${err.message}` : title}${cause}`;
}

// En el archivo, los números y los ids de chat y persona quedan ocultos salvo sus 3 últimas cifras
function toFile(line: string) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(dataDir, "logs");
  if (day !== logDay) {
    logDay = day;
    mkdirSync(dir, { recursive: true });
    const oldest = `bot-${new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)}`;
    for (const name of readdirSync(dir).filter((name) => name < oldest)) {
      rmSync(join(dir, name));
    }
  }
  appendFileSync(join(dir, `bot-${day}.log`), `${line.replace(/\d{4,}(\d{3})/g, "…$1")}\n`);
}

function print(style: string, text: string, err?: unknown, file = true) {
  const line = err === undefined ? text : `${text}: ${errorDetail(err)}`;
  const time = new Date().toLocaleTimeString("es", { hourCycle: "h23" });
  console.log(paint("90", time), paint(style, line));
  if (file) toFile(`${new Date().toISOString()} ${line}`);
}

export const log = {
  title: (text: string) =>
    console.log(`${paint("1;32", text)}\n${paint("90", "─".repeat(text.length))}`),
  info: (text: string) => print("", text),
  ok: (text: string) => print("32", text),
  warn: (text: string, err?: unknown) => print("33", text, err),
  error: (text: string, err?: unknown) => print("31", text, err),
  reveal: (text: string) => print("36", text, undefined, false),
  once: (key: string, text: string) => {
    if (!warned.has(key)) print("33", text);
    warned.add(key);
    return null;
  },
};
