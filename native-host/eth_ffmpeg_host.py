#!/usr/bin/env python3
# Native messaging host for macOS and Linux (eth_ffmpeg_host.ps1 is the Windows twin; keep both in sync).
# Reads one JSON message from the browser, answers it, exits.
# Protocol: 4-byte native-endian length + UTF-8 JSON, in both directions. Nothing else may reach stdout.
import json
import os
import shutil
import struct
import subprocess
import sys

# A browser started from the macOS Dock or a desktop launcher gets a minimal PATH without Homebrew & co.
EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin", os.path.expanduser("~/.local/bin")]


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    length = struct.unpack("=I", raw_len)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def find_ffmpeg():
    return shutil.which("ffmpeg") or shutil.which("ffmpeg", path=os.pathsep.join(EXTRA_DIRS))


# True if the video's first minute has a keyframe at least every second. Then decoding only keyframes
# yields every frame the 1 FPS output needs, about twice as fast; with sparser keyframes it would freeze.
def keyframe_every_second(ffmpeg, input_path):
    ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe")
    if not os.access(ffprobe, os.X_OK):
        ffprobe = shutil.which("ffprobe") or shutil.which("ffprobe", path=os.pathsep.join(EXTRA_DIRS))
    if not ffprobe:
        return False
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
         "-show_entries", "frame=pts_time", "-read_intervals", "%+60", "-of", "csv=p=0", input_path],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if proc.returncode != 0:
        return False
    try:
        times = sorted(float(t.strip(",")) for t in proc.stdout.decode().split() if t.strip(","))
    except ValueError:
        return False
    if len(times) < 10:
        return False
    return all(b - a <= 1.05 for a, b in zip(times, times[1:]))


# Same settings as lec-extraction-prog (FfmpegToolkit.ProcessGeneralVideoAsync: speed 1, 1 FPS, mono)
# and the same "-speed-1-compressed" name, so that app uses the file as-is instead of recompressing it.
# Preset "veryfast" rather than that app's "ultrafast": decoding the 1080p source dominates the time,
# so it is barely slower, and the video stream comes out about 7x smaller.
def convert_video(ffmpeg, input_path):
    if not (isinstance(input_path, str) and os.path.isfile(input_path) and input_path.lower().endswith(".mp4")):
        return {"ok": False, "error": f"Not an existing .mp4 file: {input_path}"}

    output = input_path[:-len(".mp4")] + "-speed-1-compressed.mp4"
    # Written under a non-video name first, so a killed run never leaves a half file that looks finished
    partial = output + ".part"

    skip = ["-skip_frame", "nokey"] if keyframe_every_second(ffmpeg, input_path) else []
    args = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *skip,
        "-i", input_path,
        "-vf", "fps=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-tune", "stillimage", "-g", "120",
        "-c:a", "aac", "-b:a", "96k", "-ac", "1", "-af", "aformat=channel_layouts=mono",
        "-r", "1", "-f", "mp4", partial,
    ]
    proc = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    if proc.returncode != 0 or not os.path.isfile(partial) or os.path.getsize(partial) < 1024:
        try:
            os.remove(partial)
        except OSError:
            pass
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        return {"ok": False, "error": f"ffmpeg exit code {proc.returncode}: {stderr}"}

    os.replace(partial, output)
    return {"ok": True, "output": output}


def main():
    try:
        msg = read_message()
        if msg is None:
            return
        ffmpeg = find_ffmpeg()
        action = msg.get("action")
        if action == "ping":
            write_message({"ok": True, "ffmpeg": bool(ffmpeg)})
        elif action == "exists":
            path = msg.get("path")
            write_message({"ok": True, "exists": isinstance(path, str) and os.path.isfile(path)})
        elif action == "convert":
            if not ffmpeg:
                write_message({"ok": False, "error": "ffmpeg not found on PATH"})
            else:
                write_message(convert_video(ffmpeg, msg.get("path")))
        else:
            write_message({"ok": False, "error": f"Unknown action: {action}"})
    except Exception as err:
        write_message({"ok": False, "error": str(err)})


if __name__ == "__main__":
    main()
