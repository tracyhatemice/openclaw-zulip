import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedZulipAccount } from "./zulip/accounts.js";
import { zulipSetupAdapter } from "./setup-core.js";
import { zulipSetupWizard } from "./setup-surface.js";
import { createZulipPluginBase } from "./shared.js";

export const zulipSetupPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  ...createZulipPluginBase({
    setupWizard: zulipSetupWizard,
    setup: zulipSetupAdapter,
  }),
};
