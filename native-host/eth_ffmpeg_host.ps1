# Native messaging host for Windows (eth_ffmpeg_host.py is the macOS/Linux twin; keep both in sync).
# Reads one JSON message from Chrome, answers it, exits.
# Protocol: 4-byte little-endian length + UTF-8 JSON, in both directions. Nothing else may reach stdout.
$ErrorActionPreference = 'Stop'

function Read-Message {
    $stdin = [Console]::OpenStandardInput()
    $lenBytes = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $n = $stdin.Read($lenBytes, $read, 4 - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    $len = [BitConverter]::ToInt32($lenBytes, 0)
    $buf = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) {
        $n = $stdin.Read($buf, $read, $len - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    return [Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json
}

function Write-Message($obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write([BitConverter]::GetBytes([int32]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Find-Ffmpeg {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# True if the video's first minute has a keyframe at least every second. Then decoding only keyframes
# yields every frame the 1 FPS output needs, about twice as fast; with sparser keyframes it would freeze.
function Test-KeyframeEverySecond($ffmpeg, $inputPath) {
    $ffprobe = Join-Path ([IO.Path]::GetDirectoryName($ffmpeg)) 'ffprobe.exe'
    if (-not (Test-Path -LiteralPath $ffprobe)) {
        $cmd = Get-Command ffprobe -ErrorAction SilentlyContinue
        if (-not $cmd) { return $false }
        $ffprobe = $cmd.Source
    }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $ffprobe
    $psi.Arguments = "-v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -read_intervals %+60 -of csv=p=0 `"$inputPath`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $proc = [Diagnostics.Process]::Start($psi)
    $out = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { return $false }

    $times = @($out -split '\s+' | ForEach-Object { $_.Trim(',') } | Where-Object { $_ } |
        ForEach-Object { [double]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) } | Sort-Object)
    if ($times.Count -lt 10) { return $false }
    for ($i = 1; $i -lt $times.Count; $i++) {
        if ($times[$i] - $times[$i - 1] -gt 1.05) { return $false }
    }
    return $true
}

# Same settings as lec-extraction-prog (FfmpegToolkit.ProcessGeneralVideoAsync: speed 1, 1 FPS, mono)
# and the same "-speed-1-compressed" name, so that app uses the file as-is instead of recompressing it.
# Preset "veryfast" rather than that app's "ultrafast": decoding the 1080p source dominates the time,
# so it is barely slower, and the video stream comes out about 7x smaller.
function Convert-Video($ffmpeg, $inputPath) {
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf) -or [IO.Path]::GetExtension($inputPath) -ne '.mp4') {
        return @{ ok = $false; error = "Not an existing .mp4 file: $inputPath" }
    }

    $dir = [IO.Path]::GetDirectoryName($inputPath)
    $base = [IO.Path]::GetFileNameWithoutExtension($inputPath)
    $output = Join-Path $dir "$base-speed-1-compressed.mp4"
    # Written under a non-video name first, so a killed run never leaves a half file that looks finished
    $partial = "$output.part"

    $skip = if (Test-KeyframeEverySecond $ffmpeg $inputPath) { '-skip_frame nokey ' } else { '' }

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $ffmpeg
    $psi.Arguments = "-hide_banner -loglevel error -nostdin -y $skip-i `"$inputPath`" -vf `"fps=1`" -c:v libx264 -preset veryfast -crf 28 -tune stillimage -g 120 -c:a aac -b:a 96k -ac 1 -af `"aformat=channel_layouts=mono`" -r 1 -f mp4 `"$partial`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardError = $true

    $proc = [Diagnostics.Process]::Start($psi)
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    if ($proc.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -lt 1024) {
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        return @{ ok = $false; error = "ffmpeg exit code $($proc.ExitCode): $($stderr.Trim())" }
    }

    Move-Item -LiteralPath $partial -Destination $output -Force
    return @{ ok = $true; output = $output }
}

try {
    $msg = Read-Message
    if ($null -eq $msg) { exit 0 }
    $ffmpeg = Find-Ffmpeg

    switch ($msg.action) {
        'ping'    { Write-Message @{ ok = $true; ffmpeg = [bool]$ffmpeg } }
        'convert' {
            if (-not $ffmpeg) { Write-Message @{ ok = $false; error = 'ffmpeg not found on PATH' } }
            else { Write-Message (Convert-Video $ffmpeg $msg.path) }
        }
        default   { Write-Message @{ ok = $false; error = "Unknown action: $($msg.action)" } }
    }
} catch {
    Write-Message @{ ok = $false; error = $_.Exception.Message }
}
