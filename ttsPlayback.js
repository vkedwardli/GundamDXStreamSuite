import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows uses native MCI; other platforms use mpv, as edge-playback already did.
// Report player startup, not the beginning of the network synthesis request.
export function playCaptionAudio(filePath, onStarted, { platform = process.platform, spawnProcess = spawn } = {}) {
  const windows = platform === "win32";
  const command = windows ? "powershell.exe" : "mpv";
  const args = windows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./ttsPlayback.ps1", import.meta.url))]
    : ["--no-video", "--input-terminal=no", "--term-osd=no", "--term-status-msg=", "--term-playing-msg=GDX_TTS_STARTED:${=duration}", "--", filePath];

  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: windows ? { ...process.env, GDX_TTS_AUDIO_FILE: filePath } : process.env,
    });
    let started = false;
    let settled = false;
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("TTS playback timed out"));
    }, 300000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const lines = output.split(/[\r\n]+/);
      output = lines.pop().slice(-4096);
      for (const line of lines) {
        const match = line.match(/GDX_TTS_STARTED:([\d.]+)/);
        if (match && !started && !settled && Number(match[1]) > 0) {
          started = true;
          onStarted(Number(match[1]) * (windows ? 1 : 1000));
        }
      }
    });
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-4096); });
    child.once("error", (error) => { settled = true; clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0 && started) resolve();
      else reject(new Error(`TTS player failed (${code}): ${errorOutput || "no playback-start signal"}`));
    });
  });
}
