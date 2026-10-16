import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { botError } from "../log.ts";
import { saveSpend, spend, type Spend } from "./store.ts";

// Dólares por millón de tokens de Sonnet 5.5, sin recargo por contexto largo
const PRICE = { input: 2, output: 10, read: 0.1, write5m: 2.5, write1h: 4, search: 0.01 };
let reserved = 0;

export const promptTokens = (u: Partial<Anthropic.Usage> = {}) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

const searchesOf = (u?: Anthropic.Usage) => u?.server_tool_use?.web_search_requests ?? 0;

// Sin desglose de la caché escrita, todo cuenta como de 1 hora, que es la que se pide
export function cost(u: Anthropic.Usage) {
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? u.cache_creation_input_tokens ?? 0;
  const five = (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) * PRICE.write5m;
  const input = u.input_tokens * PRICE.input + (u.cache_read_input_tokens ?? 0) * PRICE.read;
  const tokens = input + five + hour * PRICE.write1h + u.output_tokens * PRICE.output;
  return tokens / 1e6 + searchesOf(u) * PRICE.search;
}

export function today(): Spend {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date());
  const saved = spend();
  return saved?.day === day ? saved : { day, usd: 0, searches: 0 };
}

// Se reserva el peor gasto antes de llamar y se liquida con el real: el tope diario no se pasa
export function reserve(prompt: number, out: number) {
  const usd = ((prompt + 5000) * PRICE.write1h + out * PRICE.output) / 1e6;
  reserved += usd + PRICE.search;
  return usd + PRICE.search;
}

export function settle(usd: number, usage?: Anthropic.Usage) {
  reserved -= usd;
  if (!usage) return 0;
  const { day, usd: spent, searches } = today();
  saveSpend({ day, usd: spent + cost(usage), searches: searches + searchesOf(usage) });
  return cost(usage);
}

export const overBudget = () => today().usd + reserved >= (config.ai?.dailyBudgetUsd ?? 0);

export const searchesLeft = () =>
  Boolean(config.ai) && today().searches < (config.ai?.maxSearchesPerDay ?? Infinity);

export function apiError(err: unknown) {
  const status = (err as { status?: number } | null)?.status;
  const timeout = err instanceof Error && /timeout|abort/i.test(err.name);
  const code = timeout ? "ai_timeout" : `ai_${status ?? "error"}`;
  return botError(code, "Falló la API de Anthropic", err);
}
