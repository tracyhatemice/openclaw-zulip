import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { zulipSetupPlugin } from "./src/channel.setup.js";

export { zulipSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(zulipSetupPlugin);
