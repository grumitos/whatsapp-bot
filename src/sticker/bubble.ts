import { config } from "../config.ts";
import { log } from "../log.ts";
import { client, page, type Loose } from "../wa/client.ts";
import { mentionNames, namesOf } from "../wa/identity.ts";
import type { Media } from "../wa/media.ts";
import { SIZE } from "./tools.ts";

// El globo de WhatsApp Web en tema oscuro (WDSDarkTheme); medidas, colores y formas salen de sus
// módulos y su hoja de estilos: WAWebMessageTextBubble, WAWebMessageAuthor, WAWebMessageMeta...
const MARGIN = 8;
const BUBBLE_MAX = 260;
const MAX_CONTENT = 38 + BUBBLE_MAX;
const MAX_CHARS = 600;
const BUBBLE = "#242626";

// useWAWebDefaultProfileColors (tema oscuro): color de la foto por defecto y del nombre
const PROFILE: Record<string, [string, string]> = {
  pink: ["#FF72A1", "#36192A"],
  skyBlue: ["#53BDEB", "#092C3D"],
  yellow: ["#FFD279", "#362C1F"],
  purple: ["#A791FF", "#242447"],
  teal: ["#42C7B8", "#092D2F"],
  orange: ["#FC9775", "#35221E"],
  cobalt: ["#53A6FD", "#092642"],
  brown: ["#DBA685", "#35271E"],
  red: ["#FB5061", "#321622"],
  green: ["#25D366", "#103529"],
  gray: ["#BDBDBD", "#242626"],
};

// useWAWebGroupColors (tema oscuro, 1-17): el nombre si la cuenta no usa los colores por defecto
const GROUP_COLORS = [
  0x06cf9c, 0x53bdeb, 0xe26ab6, 0xa5b337, 0xfc9775, 0x53a6fd, 0xffb938, 0x25d366, 0xa791ff,
  0xfb5061, 0x7f66ff, 0x42c7b8, 0xff72a1, 0xd88deb, 0xfa6533, 0x02a698, 0xffd279,
];

// WAWebWrapperTailIcon: sombra + relleno; el relleno sigue 1 px bajo el globo para tapar la unión
const TAIL = `<svg viewBox="0 0 9 13" width="9" height="13">
  <path fill="#000" opacity=".13" d="M1.533,3.568L8,12.193V1H2.812 C1.042,1,0.474,2.156,1.533,3.568z"/>
  <path fill="${BUBBLE}" d="M1.533,2.568L8,11.193V0L2.812,0C1.042,0,0.474,1.156,1.533,2.568z"/>
  <rect fill="${BUBBLE}" x="7.5" y="0" width="1.5" height="11.193"/></svg>`;

// WDSIconIcPersonFilled, la foto por defecto
const PERSON =
  "M12 12c-1.1 0-2.04-.4-2.82-1.18A3.85 3.85 0 0 1 8 8c0-1.1.4-2.04 1.18-2.83A3.85 3.85 0 0 1 12 4c1.1 0 2.04.4 2.82 1.17A3.85 3.85 0 0 1 16 8c0 1.1-.4 2.04-1.18 2.82A3.85 3.85 0 0 1 12 12Zm-6 8c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41v-.8c0-.57.15-1.09.44-1.56a2.9 2.9 0 0 1 1.16-1.09 13.76 13.76 0 0 1 9.65-1.16c1.07.26 2.12.64 3.15 1.16.48.25.87.61 1.16 1.09.3.47.44 1 .44 1.56v.8c0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59H6Z";

let fontCss: string | null = null;

export type Bubble = { body: string; authorId: string; chatId: string; stanzaId?: string };
type Look = { fonts: string; name: string; elevated: boolean; color: string; time: string };

const graphemes = (t: string) => Array.from(new Intl.Segmenter().segment(t), (s) => s.segment);

function formatText(text: string) {
  const inline = (mark: string) =>
    new RegExp(
      `(^|[\\s>(])\\${mark}(?!\\s)([^${mark}\\n]+?)(?<!\\s)\\${mark}(?=$|[\\s<.,:;!?)])`,
      "g",
    );
  return Bun.escapeHTML(text)
    .replace(/```([\s\S]+?)```/g, '<code class="block">$1</code>')
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(inline("*"), "$1<b>$2</b>")
    .replace(inline("_"), "$1<i>$2</i>")
    .replace(inline("~"), "$1<s>$2</s>")
    .replace(/@⁨([^⁩]+)⁩/g, '<span class="mention">@$1</span>');
}

async function readInfo({ authorId, chatId, stanzaId }: Bubble, name: string) {
  const call = (module: string, method: string, ...args: unknown[]) =>
    Promise.resolve()
      .then(() => window.require(module)[method](...args))
      .catch(() => null);
  const { Contact, Chat, Msg } = window.require("WAWebCollections");
  const wid = window.require("WAWebWidFactory").createWid(authorId);
  const contact = Contact.get(authorId);
  const chat = Chat.get(chatId);
  const colors = "useWAWebDefaultProfileColors";
  const defaults = (await call(colors, "isDefaultProfileColorsEnabledForWid", wid)) ?? true;
  const gating = "WAWebChatProfilePictureGatingUtils";
  const initials = name && (await call(gating, "shouldDisplayInitialsInProfilePicture", wid));
  const fromName = "WAWebInitialsFromNameUtils";
  const saved = initials && chatId.endsWith("@g.us") && contact?.name;
  const fromContact = saved ? await call(fromName, "getInitialsFromContact", contact) : null;
  // No se usa getProfilePicUrl(): falla con los @lid de los grupos
  const bridge = "WAWebContactProfilePicThumbBridge";
  const picture = await call(bridge, "requestProfilePicFromServer", { id: wid });
  const original =
    stanzaId && Msg.getModelsArray().find((m: Loose) => String(m.id.id) === stanzaId);
  const elevated =
    chat && (await call("WAWebElevatedPushNamesFlag", "elevatedPushNamesEnabled", chat));
  const participant = "WAWebChatParticipantColor";
  const groupColor =
    !defaults && chat && (await call(participant, "getAssignedColor", chat, wid, "sticker"));
  const letters = [fromContact?.firstInitial, fromContact?.secondInitial].filter(Boolean);
  const first = Array.from(name).find((ch) => /\p{L}/u.test(ch));
  const shown = letters.length ? letters : [first?.toLocaleUpperCase()];
  return {
    elevated: Boolean(elevated),
    colorName: defaults ? String(await call(colors, "getWDSProfilePhotoColor", wid)) : null,
    groupColor: groupColor ? Number(groupColor) : null,
    initials: initials ? shown.filter(Boolean).map(String) : [],
    pictureUrl: picture?.eurl ? String(picture.eurl) : null,
    timestamp: original ? Number(original.t) : null,
  };
}

async function pictureDataUri(url: string | null) {
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const bytes = res?.ok ? await res.arrayBuffer().catch(() => null) : null;
  const type = res?.headers.get("content-type") ?? "image/jpeg";
  return bytes ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : null;
}

async function fonts() {
  if (fontCss !== null) return fontCss;
  const read = async () => {
    // Las hojas de otro origen no se pueden leer: quedan vacías
    const rulesOf = (sheet: CSSStyleSheet) =>
      Promise.resolve()
        .then(() => Array.from(sheet.cssRules))
        .catch(() => []);
    const rules = (await Promise.all(Array.from(document.styleSheets, rulesOf))).flat();
    const isRoboto = (rule: CSSRule): rule is CSSFontFaceRule =>
      rule instanceof CSSFontFaceRule && rule.style.fontFamily.includes("Roboto Variable");
    const face = async (rule: CSSFontFaceRule) => {
      const src = rule.style.getPropertyValue("src").match(/url\("?([^")]+)"?\)/)![1]!;
      const res = await fetch(new URL(src, rule.parentStyleSheet?.href || location.href));
      if (!res.ok) throw new Error(`HTTP ${res.status} al descargar la fuente`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `@font-face { font-family: "Roboto Variable"; font-style: ${rule.style.fontStyle}; font-weight: ${rule.style.fontWeight}; src: url(data:font/woff2;base64,${btoa(binary)}) format("woff2"); }`;
    };
    return Promise.all(rules.filter(isRoboto).map(face));
  };
  try {
    fontCss = (await page().evaluate(read)).join("\n");
    return fontCss;
  } catch (err) {
    log.warn("No se pudo cargar la fuente de WhatsApp Web, se usa la del sistema", err);
    return ""; // sin caché: se reintenta en el próximo sticker
  }
}

function avatar(picture: string | null, letters: string[], [fg, bg]: [string, string]) {
  if (picture) return `<img class="avatar" src="${picture}">`;
  const style = `style="background:${bg};color:${fg}"`;
  const inner = letters.map((l) => `<div>${Bun.escapeHTML(l)}</div>`).join("");
  if (letters.length)
    return `<div class="avatar initials${letters.length > 1 ? " two" : ""}" ${style}>${inner}</div>`;
  return `<div class="avatar icon" style="background:${bg}"><svg viewBox="0 0 24 24"><path fill="${fg}" d="${PERSON}"/></svg></div>`;
}

function html(look: Look, avatarHtml: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${look.fonts}
  html, body { margin: 0; background: transparent; }
  body { width: ${SIZE}px; height: ${SIZE}px; display: flex; align-items: center; justify-content: center; overflow: hidden;
    font-family: "Roboto Variable", Roboto, "Helvetica Neue", Helvetica, "Segoe UI Emoji", sans-serif; color: #FAFAFA;
    text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; font-feature-settings: "kern"; }
  #wrap { position: relative; padding-left: 38px; transform-origin: center; }
  .avatar { position: absolute; left: 0; top: 0; width: 28px; height: 28px; border-radius: 50%; overflow: hidden; object-fit: cover; }
  .avatar.initials { display: flex; align-items: center; justify-content: center; font-size: .875rem; }
  .avatar.initials.two { font-size: .8125rem; }
  .avatar.initials div { display: inline-block; font-weight: 500; }
  .avatar.icon { display: flex; align-items: flex-end; justify-content: center; }
  .avatar.icon svg { width: 75%; height: 75%; display: block; }
  .msg { position: relative; }
  .tail { position: absolute; left: -8px; top: 0; width: 9px; height: 13px; z-index: 300; display: block; }
  .tail svg { display: block; }
  .bubble { position: relative; z-index: 200; box-sizing: border-box; background: ${BUBBLE}; border-radius: 0 7.5px 7.5px 7.5px;
    box-shadow: 0 1px .5px rgba(11, 20, 26, .13); padding: 6px ${look.elevated ? 8 : 7}px 8px 9px; max-width: ${BUBBLE_MAX}px;
    font-size: 14.2px; line-height: 19px; }
  .author { display: inline-flex; max-width: 100%; font-size: .8rem; line-height: 22px; font-weight: 500; color: ${look.color}; }
  .name { flex: 0 1 auto; padding-left: 2px; margin-left: -2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .text-wrap { white-space: pre-wrap; overflow-wrap: break-word; }
  .text { font-size: 14px; line-height: 20px; letter-spacing: .16px; }
  .spacer { display: inline-flex; padding: 0 4px; font-size: 11px; line-height: 15px; vertical-align: middle; visibility: hidden; }
  .spacer span { display: block; }
  .meta { position: relative; z-index: 10; float: right; margin: -10px 0 -5px 4px; height: 15px; display: flex; align-items: center;
    font-size: 11px; line-height: 15px; color: rgba(255, 255, 255, .6); white-space: nowrap; }
  .meta > span { display: block; vertical-align: top; }
  .meta > span > span { font-size: 12px; font-weight: 420; line-height: 16px; }
  code { font-family: ui-monospace, Menlo, Consolas, Monaco, monospace; }
  code.block { display: block; white-space: pre-wrap; }
  .mention { color: #21C063; }
  </style></head><body><div id="wrap">${avatarHtml}<div class="msg"><span class="tail">${TAIL}</span><div class="bubble">
  <div class="author"><span class="name">${Bun.escapeHTML(look.name)}</span></div>
  <div class="text-wrap"><span><span class="text"></span><span class="spacer"><span>${look.time}</span></span></span></div>
  <div class="meta"><span><span>${look.time}</span></span></div>
  </div></div></div></body></html>`;
}

function place(content: string, maxHeight: number) {
  document.querySelector(".text")!.innerHTML = content;
  return document.getElementById("wrap")!.offsetHeight <= maxHeight;
}

function grow(size: number) {
  const wrap = document.getElementById("wrap")!;
  wrap.style.transform = `scale(${Math.min(size / wrap.offsetWidth, size / wrap.offsetHeight)})`;
}

export async function bubble(source: Bubble): Promise<Media> {
  const [name] = await namesOf([source.authorId]);
  const mentions = await mentionNames(source.body);
  const text = source.body.replace(/@(\d{5,})/g, (match, user: string) =>
    mentions.get(user) ? `@⁨${mentions.get(user)}⁩` : match,
  );
  // Lo calcula WhatsApp Web con sus propias funciones; si un módulo cambia, el valor por defecto
  const info = await page().evaluate(readInfo, source, name ?? "");
  const profile = PROFILE[info.colorName ?? ""] ?? PROFILE.gray!;
  const group = GROUP_COLORS[((info.groupColor || 1) - 1) % GROUP_COLORS.length]!;
  const color = info.colorName ? profile[0] : `#${group.toString(16).padStart(6, "0")}`;
  const clock = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const format = new Intl.DateTimeFormat(config.locale, { ...clock, timeZone: config.timeZone });
  const time = format.format(info.timestamp ? info.timestamp * 1000 : Date.now());
  const avatarHtml = avatar(await pictureDataUri(info.pictureUrl), info.initials, profile);
  const chars = graphemes(text.trim());
  const cut = (count: number) =>
    count < chars.length ? `${chars.slice(0, count).join("").trimEnd()}…` : chars.join("");
  const tab = await client.pupBrowser!.newPage();
  try {
    await tab.setViewport({ width: SIZE, height: SIZE });
    const label = name || `+${source.authorId.split("@")[0]}`;
    const look = { fonts: await fonts(), name: label, elevated: info.elevated, color, time };
    await tab.setContent(html(look, avatarHtml), { waitUntil: "load" });
    await tab.evaluate(() => document.fonts.ready);
    const fits = (count: number) => tab.evaluate(place, formatText(cut(count)), MAX_CONTENT);
    let low = 0;
    let high = Math.min(chars.length, MAX_CHARS);
    if (await fits(high)) low = high;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (await fits(mid)) low = mid;
      else high = mid - 1;
    }
    await fits(low);
    await tab.evaluate(grow, SIZE - 2 * MARGIN);
    const png = await tab.screenshot({ type: "png", omitBackground: true });
    return { data: Buffer.from(png), mimetype: "image/png" };
  } finally {
    await tab.close();
  }
}
