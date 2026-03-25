/**
 * Topic-based thread bindings for Zulip.
 *
 * Maps subagent sessions to dedicated Zulip topics within a stream,
 * analogous to Discord's thread binding system.
 */

export type TopicBindingTargetKind = "subagent";

export type TopicBindingRecord = {
  stream: string;
  topic: string;
  sessionKey: string;
  agentId: string;
  accountId: string;
  label?: string;
  boundBy: "system" | "user";
  targetKind: TopicBindingTargetKind;
  createdAt: number;
};

const bindings = new Map<string, TopicBindingRecord>();

function bindingKey(sessionKey: string, accountId: string): string {
  return `${accountId}::${sessionKey}`;
}

export function createTopicBinding(params: {
  stream: string;
  topic: string;
  sessionKey: string;
  agentId: string;
  accountId: string;
  label?: string;
  boundBy: "system" | "user";
  targetKind: TopicBindingTargetKind;
}): TopicBindingRecord {
  const record: TopicBindingRecord = {
    stream: params.stream,
    topic: params.topic,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    accountId: params.accountId,
    label: params.label,
    boundBy: params.boundBy,
    targetKind: params.targetKind,
    createdAt: Date.now(),
  };
  bindings.set(bindingKey(params.sessionKey, params.accountId), record);
  return record;
}

export function listTopicBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: TopicBindingTargetKind;
}): TopicBindingRecord[] {
  const results: TopicBindingRecord[] = [];
  for (const record of bindings.values()) {
    if (record.sessionKey !== params.targetSessionKey) continue;
    if (params.accountId && record.accountId !== params.accountId) continue;
    if (params.targetKind && record.targetKind !== params.targetKind) continue;
    results.push(record);
  }
  return results;
}

export function unbindTopicBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: TopicBindingTargetKind;
  reason?: string;
}): number {
  let removed = 0;
  for (const [key, record] of bindings.entries()) {
    if (record.sessionKey !== params.targetSessionKey) continue;
    if (params.accountId && record.accountId !== params.accountId) continue;
    if (params.targetKind && record.targetKind !== params.targetKind) continue;
    bindings.delete(key);
    removed++;
  }
  return removed;
}

export function resolveTopicForSubagent(params: {
  stream: string;
  parentTopic: string;
  label?: string;
  sessionKey: string;
}): string {
  const suffix = params.label
    ? params.label.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 40)
    : params.sessionKey.slice(0, 8);
  return `${params.parentTopic} / ${suffix}`;
}
