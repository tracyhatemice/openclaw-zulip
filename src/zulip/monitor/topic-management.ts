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

// ---------------------------------------------------------------------------
// TopicRenameTracker
// ---------------------------------------------------------------------------

export type TopicTarget = { stream: string; topic: string };

/** Internal alias target — uses topicKey (encoded) rather than raw topic name. */
type AliasTarget = { stream: string; topicKey: string };

/**
 * Tracks topic rename aliases for session continuity and resolves the
 * current (latest) topic name for message delivery.
 *
 * Uses nested Maps (`stream → topicKey → target`) instead of composite
 * string keys for type safety and clarity.
 */
export class TopicRenameTracker {
  /** Alias chain: stream → topicKey → canonical AliasTarget (NEW → OLD). */
  private readonly aliases = new Map<string, Map<string, AliasTarget>>();
  /** Forward map: canonical stream → topicKey → current TopicTarget (OLD → CURRENT). */
  private readonly currentNames = new Map<string, Map<string, TopicTarget>>();

  // --- private nested-map helpers ---

  private getAlias(stream: string, topicKey: string): AliasTarget | undefined {
    return this.aliases.get(stream)?.get(topicKey);
  }

  private setAlias(stream: string, topicKey: string, target: AliasTarget): void {
    let inner = this.aliases.get(stream);
    if (!inner) {
      inner = new Map();
      this.aliases.set(stream, inner);
    }
    inner.set(topicKey, target);
  }

  private setCurrentName(stream: string, topicKey: string, target: TopicTarget): void {
    let inner = this.currentNames.get(stream);
    if (!inner) {
      inner = new Map();
      this.currentNames.set(stream, inner);
    }
    inner.set(topicKey, target);
  }

  // --- public API ---

  /**
   * Record a topic rename/move. Returns true if a new alias was created.
   * Always updates the current-name mapping regardless of whether a new
   * alias is needed (handles rename-back-to-original).
   */
  recordRename(params: {
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

    const from = this.resolveCanonicalSessionKey(params.fromStream, fromTopic);
    const to = this.resolveCanonicalSessionKey(params.toStream, toTopic);

    // Always update current name — handles rename-back-to-original case.
    this.setCurrentName(from.stream, from.topicKey, {
      stream: params.toStream,
      topic: toTopic,
    });

    if (from.stream === to.stream && from.topicKey === to.topicKey) {
      return false;
    }

    // Point new topic's canonical at old topic's canonical.
    this.setAlias(to.stream, to.topicKey, { stream: from.stream, topicKey: from.topicKey });
    return true;
  }

  /**
   * Resolve the canonical (oldest) session key for a given stream + topic.
   * Follows the alias chain with path compression.  Depth-limited for
   * safety — cycles cannot form in normal operation but we guard against bugs.
   */
  resolveCanonicalSessionKey(
    stream: string,
    topic: string,
  ): { stream: string; topicKey: string } {
    const topicKey = buildTopicKey(topic);
    let curStream = stream;
    let curKey = topicKey;

    const chain: AliasTarget[] = [];
    for (let i = 0; i < 100; i++) {
      const next = this.getAlias(curStream, curKey);
      if (!next || (next.stream === curStream && next.topicKey === curKey)) {
        break;
      }
      chain.push({ stream: curStream, topicKey: curKey });
      curStream = next.stream;
      curKey = next.topicKey;
    }

    // Path compression: point all intermediate nodes directly at canonical.
    for (const node of chain) {
      this.setAlias(node.stream, node.topicKey, { stream: curStream, topicKey: curKey });
    }

    return { stream: curStream, topicKey: curKey };
  }

  /**
   * Resolve the current (latest renamed) topic target for delivery.
   * Returns undefined if no rename has been recorded for this canonical key.
   */
  resolveCurrentTarget(
    canonicalStream: string,
    canonicalTopicKey: string,
  ): TopicTarget | undefined {
    return this.currentNames.get(canonicalStream)?.get(canonicalTopicKey);
  }
}
