# openclaw-zulip
OpenClaw Zulip channel plugin — extracted from jamie-dit/zulip-claw and updated to work with the latest OpenClaw plugin system (2026.03.23).

## Install
### Fresh install
```bash
openclaw plugins install . ; cd ~/.openclaw/extensions/zulip ; npm install ; npm install openclaw@latest ; openclaw gateway restart
```

Then run `openclaw config` -> `Channels` -> `Add Channel` -> `Zulip` and fill in the required fields.

### Existing install
Make a copy of `openclaw.json` for both with and without the Zulip plugin, so you can easily switch between them when testing.

```bash
# remove any existing Zulip plugin and reset to the no-Zulip config;
# openclaw.json.nozulip has no zulip entries.
rm -rf ~/.openclaw/extensions/zulip && cp ~/.openclaw/openclaw.json.nozulip ~/.openclaw/openclaw.json && openclaw gateway restart

# install the Zulip plugin and switch to the Zulip config;
# openclaw.json.zulip has the Zulip channel configured with "openclaw config" command.
openclaw plugins install . ; cd ~/.openclaw/extensions/zulip ; npm install ; cd ; cp ~/.openclaw/openclaw.json.zulip ~/.openclaw/openclaw.json && openclaw gateway restart
```

## Upstream sync
```bash
git fetch upstream
git subtree pull --prefix=. upstream main --squash -- extensions/zulip
```
