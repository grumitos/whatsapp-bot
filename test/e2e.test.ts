import { beforeEach, expect, test } from "bun:test";
import type { Message } from "whatsapp-web.js";
import { saveSpend } from "../src/ai/store.ts";
import { today } from "../src/ai/spend.ts";
import { onMessage } from "../src/bot/handle.ts";
import { BLOCKED, FRIEND, GROUP, STRANGER } from "./setup.ts";
import { errors, message, requests, sent, serve } from "./setup.ts";

// Solo lo que falla sin que se note; lo visible (el bot no responde) se ve al usarlo
const deliver = (...args: Parameters<typeof message>) =>
  onMessage(message(...args) as unknown as Message);

beforeEach(() => {
  for (const list of [sent, errors, requests]) list.length = 0;
});

// El bot se reinicia solo al cambiar el código: un envío roto llega a los grupos al instante
test("!sticker con una imagen sale como sticker al grupo", async () => {
  await deliver(FRIEND, "!sticker", { chat: GROUP, image: true });
  const { mimetype, data } = sent[0]?.content as { mimetype: string; data: string };
  const webp = Buffer.from(data, "base64");
  expect(sent.map((s) => s.chatId)).toEqual([GROUP]);
  expect(mimetype).toBe("image/webp");
  expect(webp.toString("latin1", 8, 16)).toBe("WEBPVP8X");
  expect([webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1]).toEqual([512, 512]);
  expect(errors).toEqual([]);
}, 30_000);

test("sin permiso no hay respuesta ni descarga", async () => {
  await deliver(STRANGER, "!sticker", { image: true });
  await deliver(BLOCKED, "!sticker", { chat: GROUP, image: true });
  expect(sent).toEqual([]);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("un enlace que redirige fuera de los dominios permitidos no se sigue", async () => {
  const location = "https://evil.example/x";
  serve(
    "https://vt.tiktok.com/ZSevil/",
    () => new Response(null, { status: 302, headers: { location } }),
  );
  await deliver(FRIEND, "!sticker https://vt.tiktok.com/ZSevil/", { chat: GROUP });
  expect(requests).toEqual(["GET https://vt.tiktok.com/ZSevil/"]);
  expect(sent).toEqual([]);
  expect(errors[0]).toStartWith("No se pudo resolver el enlace de TikTok");
});

test("con el tope de gasto del día alcanzado, la IA no llama a la API", async () => {
  saveSpend({ ...today(), usd: 5 });
  await deliver(FRIEND, "!conciencia hola", { chat: GROUP });
  expect(requests).toEqual([]);
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});
