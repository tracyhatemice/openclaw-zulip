export type ZulipQueuePlanEntry =
  | { kind: "stream"; stream: string }
  | { kind: "dm" };

export function buildZulipQueuePlan(params: {
  streams: string[];
  dmEnabled: boolean;
}): ZulipQueuePlanEntry[] {
  const normalized = params.streams.map((stream) => stream.trim()).filter(Boolean);
  const deduped = Array.from(new Set(normalized));
  const entries: ZulipQueuePlanEntry[] = deduped.map((stream) => ({ kind: "stream", stream }));
  if (params.dmEnabled) {
    entries.push({ kind: "dm" });
  }
  return entries;
}

export function buildZulipRegisterNarrow(entry: ZulipQueuePlanEntry): string {
  if (entry.kind === "dm") {
    return JSON.stringify([["is", "dm"]]);
  }
  // "stream" is the canonical narrow operator for Zulip's API and works across older deployments.
  // Newer servers may also accept "channel", but prefer "stream" for compatibility.
  return JSON.stringify([["stream", entry.stream]]);
}
