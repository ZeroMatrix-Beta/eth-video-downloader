# Registers the ffmpeg native messaging host for the current user (no admin needed).
#   .\install.ps1 -ExtensionId <id from chrome://extensions>
#   .\install.ps1 -Uninstall
param(
    [string]$ExtensionId,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$hostName = 'eth_video_downloader.ffmpeg'
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"
$registryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)

if ($Uninstall) {
    foreach ($key in $registryKeys) { Remove-Item -Path $key -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $hostName."
    exit 0
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Error "Pass the extension's ID from chrome://extensions (32 letters a-p), e.g. .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop"
}

$manifest = [ordered]@{
    name            = $hostName
    description     = 'Converts downloaded ETH lecture videos to 1 FPS with ffmpeg'
    path            = (Join-Path $PSScriptRoot 'eth_ffmpeg_host.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# UTF-8 without BOM: Chrome rejects a manifest that starts with a BOM
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

foreach ($key in $registryKeys) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestPath
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning 'ffmpeg is not on PATH. Install it (e.g. winget install Gyan.FFmpeg) or videos will stay unconverted.'
}
Write-Host "Registered $hostName for extension $ExtensionId. Restart Chrome so it picks up the host."
