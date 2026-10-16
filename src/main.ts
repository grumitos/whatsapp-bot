import { statSync, watch } from "fs";
import { join } from "path";
import qrcode from "qrcode-terminal";
import { ROOT, config, watchConfig } from "./config.ts";
import { log } from "./log.ts";
import { check } from "./ai/ai.ts";
import { tick } from "./ai/memory.ts";
import { catchUp, onMessage } from "./bot/handle.ts";
import { updateMembers } from "./bot/members.ts";
import { client, connectionState } from "./wa/client.ts";

const inFlight = new Set<Promise<unknown>>();
let restarting = false;

log.title("WhatsApp Bot");

// Espera hasta 60 s a que termine lo que está en curso, cierra el navegador y sale: run.bat relanza
async function restart(reason: string, err?: unknown) {
  if (restarting) return;
  restarting = true;
  if (err) log.error(reason, err);
  log.warn(`${reason}. El bot se reinicia solo.`);
  await Promise.race([Promise.allSettled(inFlight), Bun.sleep(60_000)]);
  const closing = client.destroy().catch((e) => log.error("No se pudo cerrar el navegador", e));
  await Promise.race([closing, Bun.sleep(10_000)]);
  process.exit(1);
}

const track = (task: Promise<unknown>) => {
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
};

client.on("qr", (qr: string) => {
  log.info(
    "Escanea este código QR con WhatsApp > Dispositivos vinculados > Vincular un dispositivo:",
  );
  qrcode.generate(qr, { small: true }, (code: string) => process.stdout.write(`${code}\n`));
});

client.on("authenticated", () => log.info("Sesión iniciada."));
client.on("message_create", (msg) => !restarting && track(onMessage(msg)));
client.on("group_join", () => track(updateMembers()));
client.on("group_leave", () => track(updateMembers()));
client.on("disconnected", (reason) => restart(`Se perdió la conexión con WhatsApp (${reason})`));
client.on("auth_failure", (m) => restart(`No se pudo iniciar sesión en WhatsApp (${m})`));

for (const event of ["uncaughtException", "unhandledRejection"])
  process.on(event, (err) => void restart("Error inesperado", err));

client.once("ready", () => {
  log.ok("Bot listo.");
  track(updateMembers());
  track(catchUp());
  void check();
  let failed = 0;
  setInterval(async () => {
    const timeout = Bun.sleep(30_000).then(() => "sin respuesta");
    const state = await Promise.race([connectionState(), timeout]).catch((e) => `error: ${e}`);
    failed = state === "CONNECTED" ? 0 : failed + 1;
    if (failed >= 3)
      void restart(`WhatsApp no está conectado desde hace ${failed} minutos (${state})`);
  }, 60_000);
  const groups = () => [...config.groups.keys()];
  setInterval(() => tick(groups()).catch((e) => log.error("No se pudo atender la IA", e)), 120_000);
});

watchConfig(() => track(updateMembers()));

// En Windows, fs.watch también avisa cuando solo se lee un archivo: cuenta la fecha de modificación
const started = Date.now();

const edited = (file: string) =>
  (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) > started;

watch(join(ROOT, "src"), { recursive: true }, (_, file) => {
  if (file && edited(join(ROOT, "src", file))) void restart("Cambió el código del bot");
});

watch(ROOT, (_, file) => {
  if (file === ".env" && edited(join(ROOT, ".env"))) void restart("Cambió el archivo .env");
});

log.info("Conectando con WhatsApp...");
await client.initialize().catch((err) => restart("No se pudo abrir WhatsApp Web", err));
client.pupBrowser?.on("disconnected", () => restart("Se cerró el navegador"));
