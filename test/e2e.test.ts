import { beforeEach, expect, test } from "bun:test";
import type { Message } from "whatsapp-web.js";
import { saveSpend } from "../src/ai/store.ts";
import { today } from "../src/ai/spend.ts";
import { catchUp, onMessage } from "../src/bot/handle.ts";
import { webpInfo } from "../src/sticker/tools.ts";
import {
  BLOCKED,
  FRIEND,
  GROUP,
  PNG,
  SAMPLE_VIDEO,
  STRANGER,
  errors,
  failNextSend,
  lastBot,
  message,
  messageById,
  models,
  queueMissed,
  requests,
  sent,
  serve,
  soundGating,
  uploads,
} from "./setup.ts";

// Solo lo que falla sin que se note; lo visible (el bot no responde) se ve al usarlo
const deliver = (...args: Parameters<typeof message>) =>
  onMessage(message(...args) as unknown as Message);

beforeEach(() => {
  for (const list of [sent, errors, requests, uploads, models]) list.length = 0;
  messageById.clear();
  failNextSend(null);
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

test("post de Twitter/X con múltiples elementos y 1:1 convierte todos en orden", async () => {
  const tweetId = "2125097742431367661";
  serve("https://cdn.syndication.twimg.com/tweet-result", () =>
    Response.json({
      mediaDetails: [
        { type: "photo", media_url_https: "https://pbs.twimg.com/media/a.png" },
        {
          type: "animated_gif",
          media_url_https: "https://pbs.twimg.com/thumb/b.jpg",
          original_info: { width: 64, height: 48 },
          video_info: {
            variants: [{ content_type: "video/mp4", bitrate: 0, url: "https://video.twimg.com/tweet_video/b.mp4" }],
          },
        },
      ],
    }),
  );
  serve("https://pbs.twimg.com/media/a.png", () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  serve("https://video.twimg.com/tweet_video/b.mp4", () => new Response(SAMPLE_VIDEO, { headers: { "content-type": "video/mp4" } }));

  await deliver(FRIEND, `!sticker https://x.com/moefulmachi/status/${tweetId}?s=19 1:1`, { chat: GROUP });
  expect(sent).toHaveLength(2);
  expect(sent.every((s) => s.options.sendMediaAsSticker === true)).toBe(true);
  const second = webpInfo(Buffer.from((sent[1]!.content as { data: string }).data, "base64"));
  expect(second?.animated).toBe(true);
  expect([second?.width, second?.height]).toEqual([512, 512]);
  expect(errors).toEqual([]);
}, 30_000);

test("!sa crea sticker con audio nativo desde video y desde imagen + nota de voz", async () => {
  await deliver(FRIEND, "!sa", { chat: GROUP, video: true });
  expect(sent).toHaveLength(1);
  expect(soundGating.isSoundStickerConsumptionEnabled()).toBe(true);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.type).toBe("audio");
  expect(Buffer.from(uploads[0]!.mediaKey, "base64").byteLength).toBe(32);
  const extra1 = sent[0]?.options.extra as { isAnimated?: boolean; stickerAudio?: { mimetype?: string } };
  expect(extra1.isAnimated).toBe(true);
  expect(extra1.stickerAudio?.mimetype).toBe("audio/ogg; codecs=opus");

  // Flujo en dos pasos sin comando en el audio: imagen con !sa -> nota de voz que cita el aviso
  sent.length = 0;
  uploads.length = 0;
  await deliver(FRIEND, "!sa", { chat: GROUP, image: true });
  expect(sent).toHaveLength(1);
  expect(typeof sent[0]?.content).toBe("string");
  const prompt = lastBot();
  await deliver(FRIEND, "", { chat: GROUP, ptt: true, quoted: prompt });
  expect(sent).toHaveLength(2);
  expect(uploads).toHaveLength(1);
  const extra2 = sent[1]?.options.extra as { isAnimated?: boolean; stickerAudio?: { mimetype?: string } };
  expect(extra2.isAnimated).toBe(false);
  expect(extra2.stickerAudio?.mimetype).toBe("audio/ogg; codecs=opus");
  expect(errors).toEqual([]);
}, 30_000);

test("recuperación tras error transitorio reenvía solo lo pendiente sin duplicados", async () => {
  serve("https://cdn.syndication.twimg.com/tweet-result", () =>
    Response.json({
      mediaDetails: [
        { type: "photo", media_url_https: "https://pbs.twimg.com/media/p1.png" },
        { type: "photo", media_url_https: "https://pbs.twimg.com/media/p2.png" },
      ],
    }),
  );
  serve("https://pbs.twimg.com/media/p1.png", () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  serve("https://pbs.twimg.com/media/p2.png", () => new Response(PNG, { headers: { "content-type": "image/png" } }));

  failNextSend(new Error("Target closed"), 2);
  const msg = message(FRIEND, "!sticker https://x.com/user/status/999000111222333", { chat: GROUP });
  queueMissed(msg);
  await onMessage(msg as unknown as Message);
  expect(sent).toHaveLength(1);
  expect(errors).toHaveLength(1);
  errors.length = 0;

  await catchUp();
  expect(sent).toHaveLength(2);
  await catchUp();
  expect(sent).toHaveLength(2);
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
  expect(errors[0]).toContain("[link_host]");
});

test("con el tope de gasto del día alcanzado, la IA no llama a la API", async () => {
  saveSpend({ ...today(), usd: 5 });
  await deliver(FRIEND, "!conciencia hola", { chat: GROUP });
  expect(requests).toEqual([]);
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});
