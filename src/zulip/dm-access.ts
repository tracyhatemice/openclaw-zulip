import type { ZulipDmPolicy, ZulipStreamPolicy } from "../types.js";
import type { ResolvedZulipStreamEntry } from "./accounts.js";
import {
  resolveDmGroupAccessWithLists,
  type DM_GROUP_ACCESS_REASON,
} from "openclaw/plugin-sdk/channel-policy";

export type DmGroupAccessDecision = "allow" | "block" | "pairing";

export type ZulipDmAccessResult = {
  decision: DmGroupAccessDecision;
  reason: string;
  effectiveAllowFrom: string[];
};

/**
 * Resolve DM access for a 1:1 direct message.
 * Uses the SDK's `resolveDmGroupAccessWithLists` with `isGroup: false`.
 */
export function resolveZulipDmAccess(params: {
  dmPolicy: ZulipDmPolicy;
  configuredAllowFrom: (string | number)[];
  storeAllowFrom?: string[];
  senderId: number;
}): ZulipDmAccessResult {
  const result = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: params.dmPolicy,
    groupPolicy: null,
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: null,
    storeAllowFrom: params.storeAllowFrom ?? null,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) =>
      allowFrom.some(
        (entry) => entry === String(params.senderId) || entry === "*",
      ),
  });
  return {
    decision: result.decision,
    reason: result.reason,
    effectiveAllowFrom: result.effectiveAllowFrom,
  };
}

/**
 * Resolve group DM (huddle) access. Inherits DM policy result + checks enabled toggle.
 */
export function resolveZulipGroupDmAccess(params: {
  dmAccess: ZulipDmAccessResult;
  groupDmEnabled: boolean;
}): { allowed: boolean; reason: string } {
  if (!params.groupDmEnabled) {
    return { allowed: false, reason: "group DM disabled" };
  }
  if (params.dmAccess.decision !== "allow") {
    return { allowed: false, reason: `DM auth: ${params.dmAccess.reason}` };
  }
  return { allowed: true, reason: "group DM allowed (DM auth passed)" };
}

/**
 * Resolve stream message access based on account-level and per-stream policy.
 *
 * Logic:
 * 1. accountStreamPolicy === "disabled" → block
 * 2. accountStreamPolicy === "open" and no stream entries → allow any stream
 * 3. accountStreamPolicy === "allowlist" and no stream entries → block all
 * 4. If stream entry exists (direct match or wildcard "*"):
 *    - stream-level "disabled" → block
 *    - stream-level "open" → allow
 *    - stream-level "allowlist" → check allowFrom against senderId
 */
export function resolveZulipStreamAccess(params: {
  accountStreamPolicy: ZulipStreamPolicy;
  streamEntries: ResolvedZulipStreamEntry[];
  streamName: string;
  senderId: number;
}): { allowed: boolean; reason: string; requireMention: boolean } {
  const { accountStreamPolicy, streamEntries, streamName, senderId } = params;

  if (accountStreamPolicy === "disabled") {
    return { allowed: false, reason: "streamPolicy=disabled", requireMention: true };
  }

  // Find matching stream entry (exact match first, then wildcard)
  const exactEntry = streamEntries.find(
    (e) => e.streamId.toLowerCase() === streamName.toLowerCase(),
  );
  const wildcardEntry = streamEntries.find((e) => e.streamId === "*");
  const entry = exactEntry ?? wildcardEntry;

  if (!entry) {
    // No stream entry configured for this stream
    if (accountStreamPolicy === "open") {
      return { allowed: true, reason: "streamPolicy=open (no entry)", requireMention: true };
    }
    // "allowlist" with no matching entry → block
    return { allowed: false, reason: "streamPolicy=allowlist (no entry)", requireMention: true };
  }

  // Stream entry found — apply per-stream policy
  if (entry.streamPolicy === "disabled") {
    return { allowed: false, reason: `stream ${entry.streamId}: disabled`, requireMention: entry.requireMention };
  }

  if (entry.streamPolicy === "open") {
    return { allowed: true, reason: `stream ${entry.streamId}: open`, requireMention: entry.requireMention };
  }

  // "allowlist" — check sender against stream allowFrom
  if (entry.allowFrom.length === 0) {
    // allowlist with no entries → allow (stream is in the allowlist, no sender restriction)
    return { allowed: true, reason: `stream ${entry.streamId}: allowlist (no sender restriction)`, requireMention: entry.requireMention };
  }

  const senderAllowed = entry.allowFrom.some(
    (af) => af === String(senderId) || af === "*",
  );
  if (senderAllowed) {
    return { allowed: true, reason: `stream ${entry.streamId}: allowlist (sender matched)`, requireMention: entry.requireMention };
  }
  return { allowed: false, reason: `stream ${entry.streamId}: allowlist (sender not matched)`, requireMention: entry.requireMention };
}
