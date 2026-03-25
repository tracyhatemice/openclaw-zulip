import { normalizeStreamName, normalizeTopic } from "./normalize.js";

export type ZulipStreamTarget = {
  kind: "stream";
  stream: string;
  topic?: string;
};

export type ZulipDmTarget = {
  kind: "dm";
  /** User sender_id (integer as string) or email. */
  user: string;
};

export type ZulipGroupDmTarget = {
  kind: "group-dm";
  /** List of user sender_ids (integers as strings). */
  users: string[];
};

export type ZulipTarget = ZulipStreamTarget | ZulipDmTarget | ZulipGroupDmTarget;

export function parseZulipStreamTarget(raw: string): ZulipStreamTarget | null {
  let trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^zulip:/i, "").trim();
  if (!/^stream:/i.test(trimmed)) {
    return null;
  }
  trimmed = trimmed.replace(/^stream:/i, "").trim();
  if (!trimmed) {
    return null;
  }
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx < 0) {
    return { kind: "stream", stream: normalizeStreamName(trimmed) };
  }
  const streamRaw = trimmed.slice(0, hashIdx);
  const topicRaw = trimmed.slice(hashIdx + 1);
  const stream = normalizeStreamName(streamRaw);
  if (!stream) {
    return null;
  }
  const topic = normalizeTopic(topicRaw);
  return topic ? { kind: "stream", stream, topic } : { kind: "stream", stream };
}

export function parseZulipDmTarget(raw: string): ZulipDmTarget | null {
  let trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^zulip:/i, "").trim();
  const match = trimmed.match(/^(?:user|dm):(.*)/i);
  if (!match) {
    return null;
  }
  const user = match[1].trim();
  if (!user) {
    return null;
  }
  return { kind: "dm", user };
}

export function parseZulipGroupDmTarget(raw: string): ZulipGroupDmTarget | null {
  let trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^zulip:/i, "").trim();
  const match = trimmed.match(/^group-dm:(.*)/i);
  if (!match) {
    return null;
  }
  const users = match[1]
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (users.length === 0) {
    return null;
  }
  return { kind: "group-dm", users: users.toSorted() };
}

export function parseZulipTarget(raw: string): ZulipTarget | null {
  return parseZulipStreamTarget(raw) ?? parseZulipDmTarget(raw) ?? parseZulipGroupDmTarget(raw);
}

export function formatZulipStreamTarget(target: { stream: string; topic?: string }): string {
  const stream = normalizeStreamName(target.stream);
  const topic = normalizeTopic(target.topic ?? "");
  if (topic) {
    return `stream:${stream}#${topic}`;
  }
  return `stream:${stream}`;
}

export function formatZulipDmTarget(user: string | number): string {
  return `user:${user}`;
}

export function formatZulipGroupDmTarget(users: (string | number)[]): string {
  return `group-dm:${users.map(String).toSorted().join(",")}`;
}
