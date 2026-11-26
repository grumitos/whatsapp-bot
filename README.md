# whatsapp-bot

Bot de WhatsApp en TypeScript sobre Bun, con whatsapp-web.js.

## Funciones

- `!sticker`: convierte en sticker una imagen, un GIF, un video, un álbum, un texto o un enlace de TikTok, X o Instagram (incluyendo múltiples elementos). `1:1` (u otro `x:x`) recorta antes en cualquier fuente y posición.
- `!sa` / `!saudio` / `!sticker audio`: crea stickers con audio nativo desde videos, enlaces (incluidos carruseles de fotos con música de TikTok) o combinando imagen/GIF/sticker/texto con audio o nota de voz (en un paso o respondiendo al mensaje pendiente).
- `!video`: envía el video completo de YouTube, TikTok, X o Instagram, o el video adjunto/citado. Hasta 3 min, 15 MB y 480p (720p si dura 60 s o menos).
- `!clip 1:30-1:45`: envía el corte de un video de YouTube, TikTok, X o Instagram, o de un video adjunto/citado. Hasta 60 s, 15 MB y 720p.
- `!audio [1:30-1:45]`: envía el audio completo o recortado de YouTube, TikTok, X o Instagram, o de un video/audio adjunto/citado. Hasta 10 min y 15 MB.
- Los rangos aceptan segundos con decimales (`0:28.1`), minutos (`1:30.5`) o `HH:MM:SS` (`0:28:22` son 28 min 22 s).
- Respuestas fijas de texto, sticker o audio, definidas en `config.json`.
- `!consciencia`: conversación con IA (Anthropic), con memoria y tope de gasto diario.
- Permisos y límites de uso por grupo y por persona.

## Requisitos

- Bun
- ffmpeg en el `PATH` (9.0 o superior para `!sticker x:x` sobre stickers animados)
- yt-dlp en el `PATH`, para los videos de X (y de Instagram, cuando su página pública no los trae). Para YouTube hacen falta cookies (`YTDLP_COOKIES_FILE`) y, si se reutiliza el entorno de `video-downloader`, su intérprete y Deno (`YTDLP_PYTHON`, `YTDLP_DENO`).
- Chrome o Chromium (o su ruta en `CHROME_PATH`), o `chrome-headless-shell` en `.chrome/` (`bun run setup` lo descarga)
- Opcional: una clave de Anthropic para la IA

## Uso

1. Copia `config.example.json` como `config.json` y complétalo.
2. Para la IA, copia `.env.example` como `.env` y pon la clave.
3. Ejecuta `run.bat` (Windows) o `./run.sh` (Linux) y escanea el QR con WhatsApp.

## Desarrollo

```
bun test
bun run check
```

## Licencia

MIT
