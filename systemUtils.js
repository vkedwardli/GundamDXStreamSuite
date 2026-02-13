import fs from "fs/promises";
import path, { join } from "path";
import os from "os";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { scheduler } from "node:timers/promises";
import { isDev } from "./config.js";
import {
  setupLiveChatForFaction,
  startLiveChatAndViewerCount,
} from "./chatService.js"; // For lofiTest

const execPromise = promisify(exec);
const __dirname = import.meta.dirname;

export function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

export async function startDXOPScreen() {
  if (isDev) {
    console.log("Development mode: Skipping DXOP screen launch.");
    return;
  }
  const tempUserDataDir = path.join(__dirname, "chrome-user-data"); // Removed curly brace from path
  try {
    await fs.mkdir(tempUserDataDir, { recursive: true });
    let chromePath;
    if (os.platform() === "win32") {
      chromePath = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
    } else if (os.platform() === "darwin") {
      chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    } else {
      chromePath = "google-chrome"; // Linux default
    }
    const url = "http://127.0.0.1:3000/control.html";

    console.log(
      `Attempting to launch Chrome for DXOP screen: ${chromePath} with URL ${url}`
    );

    const chromeProcess = spawn(
      chromePath,
      [
        "--kiosk",
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
        "--no-report-upload",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--disable-translate",
        "--check-for-update-interval=31536000",
        "--window-position=1920,0", // Assumes secondary monitor is to the right
        `--user-data-dir=${tempUserDataDir}`,
        url,
      ],
      {
        stdio: "ignore",
        detached: false, // Keep true if you want it to run independently after this script exits
      }
    );

    chromeProcess.on("error", (err) => {
      console.error(`Error opening Chrome for DXOP screen: ${err.message}`);
      console.error(
        `Ensure Chrome is installed at the specified path or in your system's PATH.`
      );
    });

    chromeProcess.on("close", (code) => {
      console.log(`Chrome process for DXOP screen exited with code ${code}`);
    });
    console.log("DXOP screen launch initiated.");

    // Force focus the Chrome window after a short delay
    if (os.platform() === "win32") {
      setTimeout(() => {
        const psScriptPath = path.join(__dirname, "focusChrome.ps1");
        console.log(`Executing focus script via 'start': ${psScriptPath}`);
        
        // "start /min" launches a new minimized window, which has permission to change focus
        const command = `start /min powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`;
        
        exec(command, (error) => {
          if (error) {
            console.error(`Failed to launch focus script: ${error.message}`);
          } else {
            console.log("Focus script launched successfully.");
          }
        });
      }, 3000); // 3 seconds delay
    }
  } catch (error) {
    console.error("Error in startDXOPScreen setup:", error);
  }
}

async function isSpeakerConnected(macAddress) {
  if (os.platform() !== "win32") {
    console.log("Bluetooth speaker check skipped: Not on Windows.");
    return false; // Or true if you want to assume connected on non-Windows
  }
  try {
    const { stdout } = await execPromise(
      `btdiscovery -d"%c%" -i1 -b${macAddress}`
    );
    return stdout.startsWith("Yes");
  } catch (error) {
    // console.error("Error checking speaker status (btdiscovery might not be installed or in PATH):", error.message);
    return false;
  }
}

export async function connectSpeaker(speakerName, macAddress) {
  if (os.platform() !== "win32") {
    console.log("Bluetooth speaker connection skipped: Not on Windows.");
    return false;
  }
  try {
    const isConnected = await isSpeakerConnected(macAddress);
    if (isConnected) {
      console.log(`${speakerName} is already connected.`);
      exec("tone.bat", (error) => {
        if (error)
          console.error(`Error playing keep-alive tone: ${error.message}`);
      });
      return true;
    }

    console.log(`${speakerName} is not connected. Attempting to reconnect...`);
    // These commands are Windows-specific (btcom)
    await execPromise(`btcom -b "${macAddress}" -r -s110b`);
    await scheduler.wait(1000);
    await execPromise(`btcom -b "${macAddress}" -c -s110b`);
    await scheduler.wait(1000);

    const isNowConnected = await isSpeakerConnected(macAddress);
    if (isNowConnected) {
      console.log(`${speakerName} successfully reconnected.`);
      exec("tone.bat", (error) => {
        if (error)
          console.error(`Error playing keep-alive tone: ${error.message}`);
      });
      return true;
    } else {
      console.error(
        `${speakerName} failed to reconnect. Ensure btcom is installed and the device is pairable.`
      );
      return false;
    }
  } catch (error) {
    console.error(
      "Error during speaker reconnection process (btcom might not be installed or in PATH):",
      error.message
    );
    return false;
  }
}

// Example: lofiTest might need io if it emits, pass it from index.js if so.
// For now, assuming it primarily uses chatService functions that take io.
export function lofiTest(io) {
  // Added io parameter
  console.log("Running lofiTest...");
  // These are example broadcast IDs, replace with actual test IDs if needed
  let broadcastIds = ["jfKfPfyJRdk", "4xDzrJKXOOY"];
  // let broadcastIds = ["ARa-IibEfvY", "sLNGhHC0WyM"];

  // The original lofiTest called setupLiveChat and setupLiveViewerCount directly.
  // Now we use the consolidated function from chatService.
  // Ensure chatService's startLiveChatAndViewerCount is correctly imported and used.
  if (io && broadcastIds.length === 2) {
    startLiveChatAndViewerCount({ broadcastIds, io });
    console.log("Lofi test initiated chat and viewer count.");
  } else {
    console.error(
      "Lofi test could not start: io object missing or incorrect broadcastIds length."
    );
  }
}

let overlayProcess = null;
export function startOverlay() {
  if (overlayProcess) return; // Already running

  console.log("Starting scoreboard overlay...");
  const isWin = os.platform() === "win32";
  const electronCommand = isWin ? "npx.cmd" : "npx";
  
  overlayProcess = spawn(electronCommand, ["electron", "overlay.js"], {
    detached: false,
    stdio: "ignore",
    shell: isWin, // Required for .cmd files on Windows to prevent EINVAL
  });

  overlayProcess.on("error", (err) => {
    console.error(`Error starting overlay: ${err.message}`);
    overlayProcess = null;
  });

  overlayProcess.on("close", (code) => {
    console.log(`Overlay process exited with code ${code}`);
    overlayProcess = null;
  });
}

export function stopOverlay() {
  if (!overlayProcess) return;

  console.log("Stopping scoreboard overlay...");
  if (os.platform() === "win32") {
    exec(`taskkill /pid ${overlayProcess.pid} /f /t`);
  } else {
    overlayProcess.kill();
  }
  overlayProcess = null;
}
