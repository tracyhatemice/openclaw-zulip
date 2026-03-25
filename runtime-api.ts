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
export { sendZulipStreamMessage, sendZulipDirectMessage } from "./src/zulip/send.js";
export { sendZulipDirectTypingStart, sendZulipDirectTypingStop, sendZulipStreamTypingStart, sendZulipStreamTypingStop } from "./src/zulip/typing.js";
export { setZulipPresence } from "./src/zulip/presence.js";
export { getZulipRuntime, setZulipRuntime } from "./src/runtime.js";
export { registerZulipSubagentHooks } from "./src/subagent-hooks.js";
