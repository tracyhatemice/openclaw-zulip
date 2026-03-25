import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedZulipAccount } from "./zulip/accounts.js";
import { zulipSetupAdapter } from "./setup-core.js";
import { zulipSetupWizard } from "./setup-surface.js";
import { createZulipPluginBase } from "./shared.js";

const base = createZulipPluginBase({
  setupWizard: zulipSetupWizard,
  setup: zulipSetupAdapter,
});

export const zulipSetupPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  ...base,
  capabilities: base.capabilities!,
  config: base.config!,
};
