import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Temporal y renombrar: un corte a mitad no deja medio archivo
export function writeText(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export const writeJson = (file: string, value: unknown) => writeText(file, JSON.stringify(value));

export function appendLine(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}
