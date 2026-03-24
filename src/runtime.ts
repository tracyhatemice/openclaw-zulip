import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setZulipRuntime, getRuntime: getZulipRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Zulip runtime not initialized");
export { getZulipRuntime, setZulipRuntime };
