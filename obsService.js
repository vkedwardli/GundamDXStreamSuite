import { OBSWebSocket } from "obs-websocket-js";
import { exec } from "child_process";
import { scheduler } from "node:timers/promises";
import path from "path";
import os from "os";
import { obsDir, obsPath, OBS_PASSWORD } from "./config.js";
import {
  startRecognizeBattleResults,
  stopRecognizeBattleResults,
} from "./score.js"; // Assuming score.js is in the same directory

export const obs = new OBSWebSocket();

export async function obsConnect(callback) {
  try {
    if (obs.identified) {
      console.log("Already connected to OBS WebSocket.");
      if (callback) callback(true);
      return;
    }
    await obs.connect("ws://localhost:4455", OBS_PASSWORD);
    console.log("Connected to OBS WebSocket");
    if (callback) callback(true);
  } catch (error) {
    console.error("OBS Connection Error:", error.message || error);
    if (callback) callback(false);
  }
}

export async function IsLiveStreaming() {
  try {
    if (!obs.identified) {
      // console.log("OBS not connected, attempting to connect for status check.");
      // await obsConnect(); // Try to connect if not already
      // if (!obs.identified) return false; // Still not connected
      return false; // If not connected, assume not streaming
    }
    let streamStatus = await obs.call("GetStreamStatus");
    return streamStatus.outputActive;
  } catch (error) {
    // console.error("Error getting OBS stream status:", error.message);
    return false; // Assume not streaming on error
  }
}

export async function startOBSStreamingAndRecognition() {
  try {
    if (!(await IsLiveStreaming())) {
      await obs.call("StartStream");
      console.log("OBS streaming started");
      await obs.call("StartVirtualCam");
      console.log("OBS Virtual Camera started");
      await startRecognizeBattleResults();
    } else {
      console.log("OBS is streaming already!");
    }
  } catch (error) {
    console.error("Error starting OBS stream/recognition:", error);
    // Potentially try to stop virtual cam if stream start failed but cam started
    try {
      await obs.call("StopVirtualCam");
      console.log("Cleaned up OBS Virtual Camera after start error.");
    } catch (cleanupError) {
      // console.error("Error cleaning up virtual cam:", cleanupError);
    }
    await stopRecognizeBattleResults().catch((e) =>
      console.error("Error stopping recognition after start error:", e)
    );
  }
}

export async function stopOBSStreamingAndRecognition() {
  try {
    if (await IsLiveStreaming()) {
      // Check if actually streaming before trying to stop
      await obs.call("StopStream");
      console.log("OBS streaming stopped");
    } else {
      console.log("OBS was not streaming.");
    }
    // Always try to stop these, even if streaming wasn't active, as they might have been started independently or due to partial success
    await stopRecognizeBattleResults();
    await obs.call("StopVirtualCam");
    console.log("OBS Virtual Camera stopped");
  } catch (error) {
    console.error("Error stopping OBS stream/recognition:", error);
  }
}

export async function launchOBS() {
  return new Promise(async (resolve, reject) => {
    await obsConnect(async (isRunning) => {
      if (isRunning) {
        console.log("OBS Studio is already running and connected.");
        resolve(true);
      } else {
        console.log(
          "OBS Studio is not running or not connected, attempting to start and connect..."
        );
        try {
          exec(`"${obsPath}"`, { cwd: obsDir }, (error, stdout, stderr) => {
            if (error) {
              console.error(`Error launching OBS: ${error.message}`);
              // No reject here, as we'll try to connect anyway
            }
            // Don't wait for OBS to fully load, just proceed to connect attempt
          });

          // Reset capture card DirectShow settings (fire and forget)
          exec(
            `${path.join(os.homedir(), "Documents\\WebCameraConfig.exe")}`,
            { cwd: `${path.join(os.homedir(), "Documents\\")}` },
            (error, stdout, stderr) => {
              if (error)
                console.error(`Error setting camera config: ${error.message}`);
              else if (stderr) console.error(`Camera config stderr: ${stderr}`);
              else console.log("Capture card config set attempt finished.");
            }
          );

          console.log(
            "Waiting 5 seconds before attempting to connect to OBS WebSocket..."
          );
          await scheduler.wait(5000);

          await obsConnect((connected) => {
            if (connected) {
              console.log("Successfully launched and connected to OBS.");
              resolve(true);
            } else {
              console.error("Failed to connect to OBS after launch attempt.");
              resolve(false); // Resolve false instead of reject to allow main flow to continue if needed
            }
          });
        } catch (launchError) {
          console.error(
            "Critical error during OBS launch process:",
            launchError
          );
          resolve(false);
        }
      }
    });
  });
}

export async function closeOBS() {
  try {
    if (obs.identified) {
      // Only disconnect if connected
      await obs.disconnect();
      console.log("Disconnected from OBS WebSocket.");
    } else {
      console.log("OBS WebSocket was not connected, no need to disconnect.");
    }
    await scheduler.wait(1000); // Give a moment for OBS to process disconnect

    // Attempt to terminate OBS process
    // Note: taskkill is Windows-specific. For cross-platform, a library or OS check is needed.
    if (os.platform() === "win32") {
      exec("taskkill /im obs64.exe /f", (error, stdout, stderr) => {
        // Added /f to force close
        if (error && !error.message.includes("not found")) {
          // Ignore "process not found"
          console.error(`Error terminating OBS: ${error.message}`);
          return;
        }
        if (stderr && !stderr.includes("not found")) {
          // Ignore "process not found"
          console.error(`stderr while terminating OBS: ${stderr}`);
          return;
        }
        console.log("Attempted to terminate OBS process.");
      });
    } else {
      console.log("OBS termination skipped: Not on Windows.");
      // Implement termination for other OS if needed, e.g., pkill obs
    }
  } catch (error) {
    console.error("Error closing OBS:", error);
  }
}
