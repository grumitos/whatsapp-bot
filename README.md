# whatsapp-bot

Bot de WhatsApp en TypeScript sobre Bun, con whatsapp-web.js.

## Funciones

- `!sticker`: convierte en sticker una imagen, un GIF, un video, un álbum, un texto o un enlace de TikTok, X o Instagram. `!sticker 1:1` recorta antes.
- Respuestas fijas de texto, sticker o audio, definidas en `config.json`.
- `!consciencia`: conversación con IA (Anthropic), con memoria y tope de gasto diario.
- Permisos y límites de uso por grupo y por persona.

## Requisitos

- Bun
- ffmpeg en el `PATH` (9.0 o superior para `!sticker x:x` sobre stickers animados)
- yt-dlp en el `PATH`, para los videos de X (y de Instagram, cuando su página pública no los trae)
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
