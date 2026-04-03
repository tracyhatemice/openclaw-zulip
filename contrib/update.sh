#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
CONFIG="$OPENCLAW_DIR/openclaw.json"
EXTENSION_DIR="$OPENCLAW_DIR/extensions/zulip"

echo "==> Removing old extension..."
rm -rf "$EXTENSION_DIR"

echo "==> Backing up config..."
cp "$CONFIG" "$CONFIG.zulip"
cp "$CONFIG" "$CONFIG.nozulip"

echo "==> Stripping zulip entries from config..."
node -e '
const fs = require("fs");
const path = process.argv[1];
const config = JSON.parse(fs.readFileSync(path, "utf8"));

function strip(obj) {
  if (Array.isArray(obj)) {
    return obj.filter(item => {
      if (typeof item === "string" && item.includes("zulip")) return false;
      if (typeof item === "object" && item !== null && JSON.stringify(item).includes("zulip")) return false;
      return true;
    }).map(strip);
  }
  if (typeof obj === "object" && obj !== null) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.includes("zulip")) continue;
      if (typeof v === "object" && v !== null && JSON.stringify(v).includes("zulip")) continue;
      result[k] = strip(v);
    }
    return result;
  }
  return obj;
}

fs.writeFileSync(path, JSON.stringify(strip(config), null, 2) + "\n");
' "$CONFIG.nozulip"

echo "==> Applying stripped config..."
cp "$CONFIG.nozulip" "$CONFIG"

echo "==> Restarting gateway..."
openclaw gateway restart

echo "==> Installing plugin from local directory..."
openclaw plugins install .

echo "==> Restoring original config..."
cp "$CONFIG.zulip" "$CONFIG"

echo "==> Restarting gateway..."
openclaw gateway restart

echo "==> Done!"
