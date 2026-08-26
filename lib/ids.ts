import { randomUUID } from "node:crypto";

function mint(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 22);
}

export function mintListId(): string {
  return mint("lst_");
}

export function mintTaskId(): string {
  return mint("tsk_");
}

export function mintTagId(): string {
  return mint("tag_");
}
