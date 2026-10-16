import { join } from "path";
import { DATA_DIR, config, normalizePhone } from "../config.ts";
import { log } from "../log.ts";
import { writeText } from "../store.ts";
import { lidAndPhone, page, type Loose } from "../wa/client.ts";
import { namesOf } from "../wa/identity.ts";
import { isOwner, mayUse } from "./access.ts";

const participants = (groupId: string) =>
  page().evaluate((groupId) => {
    const all = window.require("WAWebCollections").Chat.get(groupId)?.groupMetadata?.participants;
    return Array.from((all?.getModelsArray() ?? []) as unknown as Loose[], (p) => String(p.id));
  }, groupId);

async function writeMembers() {
  const lines: string[] = [];
  for (const [groupId, group] of config.groups) {
    const ids = await participants(groupId).catch(() => [] as string[]);
    const [found, names] = await Promise.all([lidAndPhone(ids), namesOf(ids)]);
    lines.push(`${group.name || "(sin nombre)"} ${groupId}`);
    ids.forEach((id, i) => {
      const phone = normalizePhone(found[i]?.pn) || null;
      const lid = found[i]?.lid ?? "";
      const sender = { id: lid || id, phone, key: phone ?? (lid || id) };
      const allowed = mayUse(groupId, sender) ? "permitido" : "bloqueado";
      const fields = [names[i] || "(sin nombre)", phone ? `+${phone}` : "-", lid || "-"];
      lines.push(`  ${[...fields, isOwner(sender) ? "owner" : allowed].join(" | ")}`);
    });
  }
  writeText(join(DATA_DIR, "miembros.txt"), `${lines.join("\n")}\n`);
}

export const updateMembers = () =>
  writeMembers().catch((err) => log.error("No se pudo escribir miembros.txt", err));
