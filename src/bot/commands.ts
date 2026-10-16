import { config } from "../config.ts";
import { log } from "../log.ts";
import words from "./words.json" with { type: "json" };

const SECTIONS = ["textReplies", "quickReplies", "stickers", "audios"] as const;

export type Command =
  | { kind: "sticker" | "celebrate" | "conversation" | "status"; value?: undefined }
  | { kind: (typeof SECTIONS)[number]; value: string };

export type Match = { command: Command; rest: string };
type Entry = { alias: string; command: Command };

// "!" y la palabra pegada; también "!#" suelto (así "!#1" y el emoji "#️⃣" no cuentan)
const PATTERN = /!([\p{L}\p{N}]+|#(?![\p{L}\p{N}\p{M}]))/gu;
const BUILT_IN = { ...words, status: ["estado"] };
let cache: { source: typeof config; find: (body: string) => Match | null } | undefined;

export function normalize(text: string) {
  const lower = text.toLowerCase();
  return lower.normalize("NFD").replace(/\p{Mn}/gu, "");
}

function withinOneEdit(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const x = a.slice(i);
  const y = b.slice(i);
  const swapped = x[0] === y[1] && x[1] === y[0] && x.slice(2) === y.slice(2);
  return x.slice(1) === y.slice(1) || x.slice(1) === y || x === y.slice(1) || swapped;
}

const matcher = (entries: Entry[]) => (body: string) => {
  const text = normalize(body);
  for (const found of text.matchAll(PATTERN)) {
    const word = found[1]!;
    const singular = word.length > 2 ? word.replace(/s$/, "") : word;
    const exact = (w: string) => entries.find((e) => e.alias === w);
    const typo = (w: string) =>
      entries.find((e) => e.alias.length >= 6 && withinOneEdit(w, e.alias));
    const hit = exact(word) ?? exact(singular) ?? typo(word) ?? typo(singular);
    if (hit) return { command: hit.command, rest: text.slice(found.index + found[0].length) };
  }
  return null;
};

function build() {
  const entries: Entry[] = Object.entries(BUILT_IN).flatMap(([kind, aliases]) =>
    aliases.map((alias) => ({ alias: normalize(alias), command: { kind } as Command })),
  );
  for (const kind of SECTIONS) {
    for (const [word, value] of Object.entries(config[kind])) {
      const typed = normalize(`!${word}`);
      const valid = typed.match(PATTERN)?.[0] === typed;
      const why = valid ? "ya es otro comando" : "no es una palabra";
      if (!valid || matcher(entries)(typed))
        log.warn(`config.json: ${kind}.${word} se ignora: ${why}.`);
      else entries.push({ alias: normalize(word), command: { kind, value } });
    }
  }
  return matcher(entries);
}

export function findCommand(body: string) {
  if (cache?.source !== config) cache = { source: config, find: build() };
  return cache.find(body);
}
