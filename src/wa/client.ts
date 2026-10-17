import { existsSync, readdirSync } from "fs";
import { join } from "path";
import pkg from "whatsapp-web.js";
import { ROOT } from "../config.ts";

export type Loose = { [key: string]: Loose } & ((...args: unknown[]) => Loose);

declare global {
  interface Window {
    require(name: string): Loose;
    WWebJS: Loose;
  }
}

const windows = process.platform === "win32";

function headlessShell() {
  const name = "chrome-headless-shell";
  const dir = join(ROOT, ".chrome", name);
  const versions = existsSync(dir) ? readdirSync(dir) : [];
  versions.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const folder = `${name}-${windows ? "win64" : "linux64"}`;
  const file = windows ? `${name}.exe` : name;
  const exes = versions.map((version) => join(dir, version, folder, file));
  return exes.filter((exe) => existsSync(exe)).pop();
}

// CHROME_PATH manda; si no, el headless shell de .chrome/ y por último el Chrome del sistema
const forced = process.env.CHROME_PATH;
const shell = forced ? undefined : headlessShell();
const system = windows
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
const cache = shell ? [`--disk-cache-dir=${join(ROOT, ".wwebjs_cache", "http")}`] : [];
const lean = ["--disable-gpu", "--disable-component-update", "--disable-domain-reliability"];
const isolation = ["--no-sandbox", "--disable-site-isolation-trials", "--no-default-browser-check"];
const procs = "--disable-features=site-per-process,IsolateOrigins,SpareRendererForSitePerProcess";

export const client = new pkg.Client({
  authStrategy: new pkg.LocalAuth({ clientId: "sticker-bot" }),
  puppeteer: {
    executablePath: forced || shell || system,
    headless: shell ? "shell" : true,
    args: [...lean, ...isolation, procs, ...cache],
  },
});

export const page = () => client.pupPage!;

// No se usa getState(): lanza con el cliente conectado. Se lee el estado del socket en la página
export const connectionState = () =>
  page().evaluate(() => String(window.require("WAWebSocketModel").Socket.state));

// getContactLidAndPhone (librería) lee _serialized, que los ids no traen: se arman con sus partes
export const lidAndPhone = (ids: string[]) =>
  page().evaluate((ids) => {
    const wid = (w?: Loose) => (w ? `${w.user}@${w.server}` : undefined);
    const one = async (id: string) => {
      const { lid, phone } = await window.WWebJS.enforceLidAndPnRetrieval(id);
      return { lid: wid(lid), pn: wid(phone) };
    };
    return Promise.all(ids.map(one));
  }, ids);
