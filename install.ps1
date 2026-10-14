# Install herdr-ompg-bridge into an omp/ompg config directory (Windows).
#
# Usage:
#   powershell -File install.ps1                # auto-detect target
#   powershell -File install.ps1 -Target C:\Users\me\.ompg
#   powershell -File install.ps1 -RemoveOfficial  # also delete herdr's bundled integration
param(
    [string]$Target = "",
    [switch]$RemoveOfficial
)
$ErrorActionPreference = "Stop"

if (-not $Target) {
    if ($env:PI_CONFIG_DIR) {
        $Target = Join-Path $env:USERPROFILE $env:PI_CONFIG_DIR
    } elseif (Test-Path (Join-Path $env:USERPROFILE ".ompg")) {
        $Target = Join-Path $env:USERPROFILE ".ompg"
    } else {
        $Target = Join-Path $env:USERPROFILE ".omp"
    }
}

$extensionsDir = Join-Path $Target "agent\extensions"
if (-not (Test-Path $extensionsDir)) {
    throw "Not an omp/ompg config directory (missing $extensionsDir). Pass -Target explicitly."
}

$official = Join-Path $extensionsDir "herdr-omp-agent-state.ts"
if (Test-Path $official) {
    if ($RemoveOfficial) {
        Remove-Item $official
        Write-Host "Removed herdr's bundled integration: $official"
        Write-Host "Also run 'herdr integration uninstall omp' so herdr stops managing it."
    } else {
        Write-Host "WARNING: herdr's bundled integration is still present:" -ForegroundColor Yellow
        Write-Host "  $official"
        Write-Host "Two reporters will fight over the pane state. Re-run with -RemoveOfficial,"
        Write-Host "or run: herdr integration uninstall omp  (and delete the file above manually)."
    }
}

$src = Join-Path $PSScriptRoot "herdr-ompg-bridge.ts"
Copy-Item $src $extensionsDir -Force
Write-Host "Installed: $(Join-Path $extensionsDir 'herdr-ompg-bridge.ts')"
Write-Host "Restart omp/ompg inside a herdr pane to activate. Check with /herdr status."
