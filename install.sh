#!/usr/bin/env bash
# Install herdr-ompg-bridge into an omp/ompg config directory (Unix).
#
# Usage:
#   ./install.sh                     # auto-detect target
#   ./install.sh ~/.omp              # explicit target
#   ./install.sh --remove-official   # also delete herdr's bundled integration
set -euo pipefail

target=""
remove_official=0
for arg in "$@"; do
    case "$arg" in
        --remove-official) remove_official=1 ;;
        *) target="$arg" ;;
    esac
done

if [[ -z "$target" ]]; then
    if [[ -n "${PI_CONFIG_DIR:-}" ]]; then
        target="$HOME/$PI_CONFIG_DIR"
    elif [[ -d "$HOME/.ompg" ]]; then
        target="$HOME/.ompg"
    else
        target="$HOME/.omp"
    fi
fi

extensions_dir="$target/agent/extensions"
if [[ ! -d "$extensions_dir" ]]; then
    echo "Not an omp/ompg config directory (missing $extensions_dir). Pass the target explicitly." >&2
    exit 1
fi

official="$extensions_dir/herdr-omp-agent-state.ts"
if [[ -f "$official" ]]; then
    if [[ "$remove_official" -eq 1 ]]; then
        rm -f "$official"
        echo "Removed herdr's bundled integration: $official"
        echo "Also run 'herdr integration uninstall omp' so herdr stops managing it."
    else
        echo "WARNING: herdr's bundled integration is still present:"
        echo "  $official"
        echo "Two reporters will fight over the pane state. Re-run with --remove-official,"
        echo "or run: herdr integration uninstall omp  (and delete the file above manually)."
    fi
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$script_dir/herdr-ompg-bridge.ts" "$extensions_dir/"
echo "Installed: $extensions_dir/herdr-ompg-bridge.ts"
echo "Restart omp/ompg inside a herdr pane to activate. Check with /herdr status."
