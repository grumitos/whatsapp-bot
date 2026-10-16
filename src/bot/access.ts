import { config, normalizePhone, type Person } from "../config.ts";
import { isGroup, selfId, type Sender } from "../wa/identity.ts";

export const isOwner = ({ phone }: Sender) =>
  phone !== null && (phone === normalizePhone(selfId()) || config.owners.has(phone));

export function personRule(chatId: string, sender: Sender): Person {
  const pick = (people: Record<string, Person> = {}) =>
    Object.entries(people[sender.key] ?? people[sender.id] ?? {}).filter(
      ([, v]) => v !== undefined,
    );
  const group = config.groups.get(chatId)?.people;
  return Object.fromEntries([...pick(config.people), ...pick(group)]);
}

export function mayUse(chatId: string, sender: Sender) {
  if (isOwner(sender)) return true;
  const group = config.groups.get(chatId);
  const { access } = personRule(chatId, sender);
  if (group) return group.listed ? access === "allow" : access !== "block";
  const allowed = sender.phone !== null && config.phones.has(sender.phone);
  return !isGroup(chatId) && allowed && access !== "block";
}
