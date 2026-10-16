# whatsapp-bot

Bot de WhatsApp en TypeScript sobre Bun, con whatsapp-web.js.

## Funciones

- `!sticker`: convierte en sticker una imagen, un GIF, un video, un álbum, un texto o un enlace de TikTok o X. `!sticker 1:1` recorta antes.
- Respuestas fijas de texto, sticker o audio, definidas en `config.json`.
- `!conciencia`: conversación con IA (Anthropic), con memoria y tope de gasto diario.
- Permisos y límites de uso por grupo y por persona.

## Requisitos

- Bun
- ffmpeg en el `PATH`
- yt-dlp en el `PATH`, para los videos de X
- Chrome, o `chrome-headless-shell` en `.chrome/`
- Opcional: una clave de Anthropic para la IA

## Uso

1. Copia `config.example.json` como `config.json` y complétalo.
2. Para la IA, copia `.env.example` como `.env` y pon la clave.
3. Ejecuta `run.bat` y escanea el QR con WhatsApp.

## Desarrollo

```
bun test
bun run check
```

## Licencia

MIT
