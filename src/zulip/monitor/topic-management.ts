import crypto from "node:crypto";
import { normalizeTopic } from "../normalize.js";
import type { ZulipEvent, ZulipUpdateMessageEvent } from "./types.js";

export function buildTopicKey(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  const encoded = encodeURIComponent(normalized);
  if (encoded.length <= 80) {
    return encoded;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 64)}~${digest}`;
}

/**
 * Reverse a topic key produced by `buildTopicKey` back to its raw lowercase form.
 * Truncated keys (containing `~`) cannot be reliably decoded, so they are returned as-is.
 */
export function safeDecodeTopicKey(topicKey: string): string {
  if (topicKey.includes("~")) {
    return topicKey;
  }
  try {
    return decodeURIComponent(topicKey);
  } catch {
    return topicKey;
  }
}

export function isZulipUpdateMessageEvent(event: ZulipEvent): event is ZulipUpdateMessageEvent {
  return event.type === "update_message";
}

export function parseTopicRenameEvent(
  event: ZulipEvent,
): { fromTopic: string; toTopic: string; origStreamId?: number; newStreamId?: number } | undefined {
  if (!isZulipUpdateMessageEvent(event)) {
    return undefined;
  }

  const origStreamId = event.orig_stream_id;
  const newStreamId = event.stream_id;
  const isCrossStream =
    typeof origStreamId === "number" &&
    typeof newStreamId === "number" &&
    origStreamId !== newStreamId;

  const fromTopic = normalizeTopic(event.orig_topic ?? event.orig_subject);
  const toTopic = normalizeTopic(event.topic ?? event.subject);

  if (isCrossStream) {
    // For cross-stream moves, the topic name may or may not change.
    // If orig_topic is absent, the topic name stayed the same during the move.
    const effectiveFrom = fromTopic || toTopic;
    const effectiveTo = toTopic || fromTopic;
    if (!effectiveFrom || !effectiveTo) {
      return undefined;
    }
    return { fromTopic: effectiveFrom, toTopic: effectiveTo, origStreamId, newStreamId };
  }

  // Same-stream: require actual topic name change.
  if (!fromTopic || !toTopic) {
    return undefined;
  }

  if (buildTopicKey(fromTopic) === buildTopicKey(toTopic)) {
    return undefined;
  }

  return { fromTopic, toTopic };
}

export function resolveCanonicalTopicSessionKey(params: {
  aliases: Map<string, string>;
  stream: string;
  topic: string;
}): { stream: string; topicKey: string } {
  const topicKey = buildTopicKey(params.topic);
  let compositeKey = `${params.stream}\0${topicKey}`;

  const visited = new Set<string>();
  const visitedOrder: string[] = [];

  while (true) {
    const next = params.aliases.get(compositeKey);
    if (!next || next === compositeKey || visited.has(compositeKey)) {
      break;
    }
    visited.add(compositeKey);
    visitedOrder.push(compositeKey);
    compositeKey = next;
  }

  // Path compression: point all intermediate aliases directly at the canonical key.
  if (visitedOrder.length > 0) {
    for (const alias of visitedOrder) {
      params.aliases.set(alias, compositeKey);
    }
  }

  const sepIdx = compositeKey.indexOf("\0");
  const stream = compositeKey.substring(0, sepIdx);
  const resolvedTopicKey = compositeKey.substring(sepIdx + 1);
  return { stream, topicKey: resolvedTopicKey };
}

export function recordTopicRenameAlias(params: {
  aliases: Map<string, string>;
  fromStream: string;
  fromTopic: string;
  toStream: string;
  toTopic: string;
}): boolean {
  const fromTopic = normalizeTopic(params.fromTopic);
  const toTopic = normalizeTopic(params.toTopic);
  if (!fromTopic || !toTopic) {
    return false;
  }

  const fromResult = resolveCanonicalTopicSessionKey({
    aliases: params.aliases,
    stream: params.fromStream,
    topic: fromTopic,
  });
  const toResult = resolveCanonicalTopicSessionKey({
    aliases: params.aliases,
    stream: params.toStream,
    topic: toTopic,
  });

  const fromCompositeKey = `${fromResult.stream}\0${fromResult.topicKey}`;
  const toCompositeKey = `${toResult.stream}\0${toResult.topicKey}`;

  if (fromCompositeKey === toCompositeKey) {
    return false;
  }

  params.aliases.set(toCompositeKey, fromCompositeKey);
  return true;
}
