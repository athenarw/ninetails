#!/usr/bin/env bash
# Cross-compile NinetailsSettings.exe and NinetailsTidy.exe from Linux/macOS with Zig.
#   pip install ziglang     (or install zig from ziglang.org)
set -euo pipefail
cd "$(dirname "$0")"
ZIG="${ZIG:-python3 -m ziglang}"
OUT="$(mktemp -d)"
build() { # name, extra flags
  $ZIG cc -target x86_64-windows-gnu -O2 -s -municode -Wl,--subsystem,windows $2 \
    ninetails-settings.c "$3" -lshell32 -luser32 -o "$OUT/$1"
  cp "$OUT/$1" "../$1"
  echo "Built ../$1"
}
build NinetailsSettings.exe "" ninetails-settings.rc
build NinetailsTidy.exe "-DNT_TIDY" ninetails-tidy.rc
rm -rf "$OUT"
