import { statSync } from "fs";
import { join, resolve } from "path";
import { log, setDataDir } from "./log.ts";
import { readJson } from "./store.ts";

export const ROOT = join(import.meta.dir, "..");
const FILE = join(ROOT, "config.json");
const LIMITS = ["replies", "conversation", "chatReplies", "chatConversation"] as const;
const SECTIONS = ["textReplies", "quickReplies", "stickers", "audios"] as const;
const AI = { dailyBudgetUsd: 1, webSearch: true, farewell: "Adiós" };

export type Limit = { max: number; hours: number } | "unlimited";
export type Limits = Partial<Record<(typeof LIMITS)[number], Limit>>;
export type Person = Limits & { access?: "allow" | "block" };
type Obj = Record<string, unknown>;
type Texts = Record<(typeof SECTIONS)[number], Record<string, string>>;
let owners = new Set<string>();

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const entriesOf = (value: unknown) => Object.entries(isObj(value) ? value : {});

// Un móvil de Brasil es el mismo con o sin el 9 añadido en 2012
export const normalizePhone = (value: unknown) =>
  String(value ?? "")
    .replace(/\D/g, "")
    .replace(/^55(\d{2})9?([6-9]\d{7})$/, "55$1$2");

function check<T>(value: unknown, valid: boolean, path: string, why: string) {
  if (value !== undefined && !valid) log.warn(`config.json: ${path} se ignora: ${why}.`);
  return valid ? (value as T) : undefined;
}

function limits(source: unknown, path: string): Limits {
  const entries = LIMITS.map((key) => {
    const v = isObj(source) ? source[key] : undefined;
    const { max, hours } = (isObj(v) ? v : {}) as { max?: number; hours?: number };
    const ok = v === "unlimited" || (Number.isInteger(max) && max! >= 0 && Number(hours) > 0);
    return [key, check(v, ok, `${path}.${key}`, 'usa { "max", "hours" } o "unlimited"')];
  });
  return Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));
}

function people(source: unknown, path: string) {
  const entries = entriesOf(source).map(([key, entry]) => {
    const rule = isObj(entry) ? entry : { access: entry };
    const id = key.includes("@") ? key : normalizePhone(key);
    const ok = rule.access === "allow" || (rule.access === "block" && !owners.has(id));
    const why = "usa allow o block (un owner no se puede bloquear)";
    const access = check<Person["access"]>(rule.access, ok, `${path}.${key}`, why);
    return [id, { access, ...limits(rule, `${path}.${key}`) }];
  });
  return Object.fromEntries(entries) as Record<string, Person>;
}

function group([id, value]: [string, unknown]) {
  const entry = isObj(value) ? value : { name: value };
  const path = `allowedGroups.${id}`;
  const valid = entry.members === "listed" || entry.members === "everyone";
  const listed = check(entry.members, valid, path, 'usa "everyone" o "listed"') === "listed";
  const rules = { people: people(entry.people, path), limits: limits(entry.limits, path) };
  return [id, { name: String(entry.name ?? ""), listed, ...rules }] as const;
}

function texts(section: string, source: unknown) {
  const valid = ([word, text]: [string, unknown]) =>
    check(text, typeof text === "string" && text.trim() !== "", `${section}.${word}`, "sin texto");
  return [section, Object.fromEntries(entriesOf(source).filter(valid))];
}

// Un valor mal escrito en lo que protege dinero apaga la IA en vez de dejarla sin tope
function ai(
  source: unknown,
): (typeof AI & { country?: string; maxSearchesPerDay?: number }) | null {
  const raw = isObj(source) ? source : {};
  const settings = { ...AI, ...raw };
  const valid = (key: keyof typeof AI) =>
    typeof settings[key] === typeof AI[key] && !(Number(settings[key]) < 0);
  const country = check<string>(raw.country, typeof raw.country === "string", "ai", "country");
  const searches = raw.maxSearchesPerDay as number | undefined;
  const searchesOk = searches === undefined || (Number.isInteger(searches) && searches >= 0);
  const keys = Object.keys(AI) as (keyof typeof AI)[];
  if (searchesOk && keys.every(valid)) return { ...settings, country, maxSearchesPerDay: searches };
  log.error("La IA queda apagada: la sección ai de config.json tiene un valor mal escrito.");
  return null;
}

function parse(raw: Obj) {
  const phones = (list: unknown) =>
    new Set((Array.isArray(list) ? list : []).map(normalizePhone).filter(Boolean));
  const zoneOk = Intl.supportedValuesOf("timeZone").includes(String(raw.timeZone));
  const localeOk = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(String(raw.locale));
  owners = phones(raw.ownerPhones);
  return {
    owners,
    phones: phones(raw.allowedPhones),
    people: people(raw.people, "people"),
    limits: { chatConversation: { max: 5, hours: 1 }, ...limits(raw.limits, "limits") } as Limits,
    groups: new Map(entriesOf(raw.allowedGroups).map(group)),
    ...(Object.fromEntries(SECTIONS.map((section) => texts(section, raw[section]))) as Texts),
    ai: ai(raw.ai),
    timeZone: check<string>(raw.timeZone, zoneOk, "timeZone", "no es válida") ?? "UTC",
    locale: check<string>(raw.locale, localeOk, "locale", "no es válido") ?? "es",
  };
}

const first = readJson<Obj | null>(FILE, null);
export const DATA_DIR = resolve(ROOT, typeof first?.dataDir === "string" ? first.dataDir : "data");
setDataDir(DATA_DIR);
export let config = parse(first ?? {});
if (!first) log.warn("Sin config.json válido: sin grupos ni owners (ver config.example.json).");

export function watchConfig(onChange: () => void) {
  const stamp = () => statSync(FILE, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  let seen = stamp();
  setInterval(() => {
    if (stamp() === seen) return;
    seen = stamp();
    const raw = readJson<Obj | null>(FILE, null);
    if (!raw) return log.error("config.json tiene un error de escritura; se mantiene la anterior.");
    config = parse(raw);
    log.info("Configuración recargada.");
    onChange();
  }, 1000);
}
