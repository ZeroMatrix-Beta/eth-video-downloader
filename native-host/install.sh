#!/usr/bin/env bash
# Registers the ffmpeg native messaging host for the current user on macOS or Linux (no sudo needed).
#   bash install.sh <extension id from chrome://extensions>
#   bash install.sh --uninstall
set -euo pipefail

HOST_NAME="eth_video_downloader.ffmpeg"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$SCRIPT_DIR/eth_ffmpeg_host.py"

case "$(uname -s)" in
    Darwin)
        BASE="$HOME/Library/Application Support"
        BROWSER_DIRS=("Google/Chrome" "Chromium" "Microsoft Edge" "BraveSoftware/Brave-Browser")
        ;;
    Linux)
        BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
        BROWSER_DIRS=("google-chrome" "chromium" "microsoft-edge" "BraveSoftware/Brave-Browser")
        ;;
    *)
        echo "Unsupported system $(uname -s). On Windows use install.ps1." >&2
        exit 1
        ;;
esac

if [ "${1:-}" = "--uninstall" ]; then
    for dir in "${BROWSER_DIRS[@]}"; do
        rm -f "$BASE/$dir/NativeMessagingHosts/$HOST_NAME.json"
    done
    echo "Removed $HOST_NAME."
    exit 0
fi

EXTENSION_ID="${1:-}"
if ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    echo "Pass the extension's ID from chrome://extensions (32 letters a-p), e.g." >&2
    echo "  bash install.sh abcdefghijklmnopabcdefghijklmnop" >&2
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required (macOS: xcode-select --install or brew install python)." >&2
    exit 1
fi
chmod +x "$HOST_PATH"

# Only browsers that are installed (their profile folder exists) get the manifest
registered=0
for dir in "${BROWSER_DIRS[@]}"; do
    [ -d "$BASE/$dir" ] || continue
    mkdir -p "$BASE/$dir/NativeMessagingHosts"
    python3 - "$BASE/$dir/NativeMessagingHosts/$HOST_NAME.json" "$HOST_NAME" "$HOST_PATH" "$EXTENSION_ID" <<'EOF'
import json, sys
path, name, host, ext = sys.argv[1:]
with open(path, "w") as f:
    json.dump({
        "name": name,
        "description": "Converts downloaded ETH lecture videos to 1 FPS with ffmpeg",
        "path": host,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext}/"],
    }, f, indent=2)
EOF
    echo "Registered for $dir"
    registered=$((registered + 1))
done

if [ "$registered" -eq 0 ]; then
    echo "No Chrome, Chromium, Edge or Brave profile found under $BASE." >&2
    echo "(Snap and Flatpak browsers keep their profile elsewhere and are not supported.)" >&2
    exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1 && ! [ -x /opt/homebrew/bin/ffmpeg ] && ! [ -x /usr/local/bin/ffmpeg ]; then
    echo "Warning: ffmpeg not found (macOS: brew install ffmpeg, Linux: your package manager)." >&2
fi
echo "Done. Restart the browser so it picks up the helper."
