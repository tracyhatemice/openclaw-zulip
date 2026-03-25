import { describe, expect, it } from "vitest";
import { buildZulipQueuePlan, buildZulipRegisterNarrow } from "./queue-plan.js";

describe("zulip queue plan", () => {
  it("dedupes and trims streams", () => {
    expect(
      buildZulipQueuePlan({ streams: [" marcel-ai ", "marcel-ai", "", "  ", "ops"], dmEnabled: false }).map((entry) => entry),
    ).toEqual([{ kind: "stream", stream: "marcel-ai" }, { kind: "stream", stream: "ops" }]);
  });

  it("adds a dm entry when dmEnabled is true", () => {
    expect(
      buildZulipQueuePlan({ streams: ["general"], dmEnabled: true }),
    ).toEqual([{ kind: "stream", stream: "general" }, { kind: "dm" }]);
  });

  it("builds a channel narrow for a stream entry", () => {
    expect(buildZulipRegisterNarrow({ kind: "stream", stream: "marcel-ai" })).toBe('[["stream","marcel-ai"]]');
  });

  it("builds a dm narrow for a dm entry", () => {
    expect(buildZulipRegisterNarrow({ kind: "dm" })).toBe('[["is","dm"]]');
  });
});
