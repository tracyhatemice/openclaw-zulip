// Re-exports from the SDK for consumers that need types alongside Zulip internals.
export type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/core";

// Zulip runtime internals.
export { monitorZulipProvider } from "./src/zulip/monitor.js";
export { probeZulip } from "./src/zulip/probe.js";
export { sendZulipStreamMessage } from "./src/zulip/send.js";
export { getZulipRuntime, setZulipRuntime } from "./src/runtime.js";
