import { OBSWebSocket } from "obs-websocket-js";
import { exec } from "child_process";
import { scheduler } from "node:timers/promises";
import path from "path";
import os from "os";
import { obsDir, obsPath, OBS_PASSWORD } from "./config.js";
import {
  startRecognizeBattleResults,
  stopRecognizeBattleResults,
  prepareScoresForStream,
} from "./score.js";
import { io } from "./serverSetup.js";
import { withTimeout } from "./shutdown.js";

export const obs = new OBSWebSocket();
const OBS_REQUEST_TIMEOUT_MS = 5000;
const OBS_PROCESS_EXIT_TIMEOUT_MS = 15000;
const OBS_PROCESS_EXIT_POLL_MS = 500;
let connecting = null;

export async function obsConnect(callback) {
  if (!obs.identified && !connecting) {
    // Concurrent camera/status/stop requests must share a connection attempt.
    // obs.connect() disconnects any existing socket before opening a new one.
    connecting = (async () => {
      try {
        await withTimeout(() => obs.connect("ws://localhost:4455", OBS_PASSWORD),
          OBS_REQUEST_TIMEOUT_MS, "OBS connection");
        console.log("Connected to OBS WebSocket");
        return true;
      } catch (error) {
        console.error("OBS Connection Error:", error.message || error);
        // Also cancel a handshake that has not completed by the deadline.
        await withTimeout(() => obs.disconnect(), OBS_REQUEST_TIMEOUT_MS,
          "OBS connection cleanup").catch(() => {});
        return false;
      }
    })().finally(() => { connecting = null; });
  }
  const connected = connecting ? await connecting : obs.identified;
  if (callback) await callback(connected);
  return connected;
}

// null means unknown, including a lost control connection. It must never be
// used as evidence that OBS has stopped broadcasting.
export async function getOBSStreamingState({ reconnect = false } = {}) {
  try {
    if (!obs.identified && reconnect) await obsConnect();
    if (!obs.identified) return null;
    const status = await withTimeout(() => obs.call("GetStreamStatus"),
      OBS_REQUEST_TIMEOUT_MS, "OBS stream status");
    return typeof status.outputActive === "boolean" ? status.outputActive : null;
  } catch (error) {
    console.error("Could not determine OBS streaming state:", error.message);
    return null;
  }
}

export async function IsLiveStreaming() {
  return (await getOBSStreamingState()) === true;
}

export async function startOBSStreamingAndRecognition(onIdleShutdown, isPublic, isCurrent = () => true,
  { recovery = false } = {}) {
  try {
    const isResuming = await IsLiveStreaming();
    if (!isCurrent()) return false;
    if (!isResuming) {
      await withTimeout(() => obs.call("StartStream"), OBS_REQUEST_TIMEOUT_MS, "OBS StartStream");
      if (!isCurrent()) return false;
      console.log("OBS streaming started");
    } else {
      console.log("OBS is streaming already, re-initiating recognition...");
    }
    if (recovery) {
      const camera = await withTimeout(() => obs.call("GetVirtualCamStatus"),
        OBS_REQUEST_TIMEOUT_MS, "OBS virtual camera status");
      if (!isCurrent()) return false;
      if (!camera.outputActive) await withTimeout(() => obs.call("StartVirtualCam"),
        OBS_REQUEST_TIMEOUT_MS, "OBS StartVirtualCam");
    } else if (!isResuming) {
      await withTimeout(() => obs.call("StartVirtualCam"), OBS_REQUEST_TIMEOUT_MS, "OBS StartVirtualCam");
      console.log("OBS Virtual Camera started");
    }
    if (!isCurrent()) return false;
    if (recovery) {
      let active = false;
      for (let attempt = 0; attempt < 10 && isCurrent(); attempt++) {
        const stream = await getOBSStreamingState();
        const camera = await withTimeout(() => obs.call("GetVirtualCamStatus"),
          OBS_REQUEST_TIMEOUT_MS, "OBS virtual camera status");
        if (stream === true && camera.outputActive === true) { active = true; break; }
        await scheduler.wait(500);
      }
      if (!isCurrent()) return false;
      if (!active) throw new Error("OBS stream and virtual camera did not both become active.");
    }
    // Recovery belongs to the same broadcast even though its encoder stopped.
    prepareScoresForStream(isResuming || recovery);
    // Always start recognition; it's a local process needed for both new and resumed streams.
    await startRecognizeBattleResults(onIdleShutdown, isPublic);
    // Worker creation can finish after a concurrent stop has already cleaned up.
    if (!isCurrent()) {
      await stopRecognizeBattleResults();
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error starting OBS stream/recognition:", error);
    // Potentially try to stop virtual cam if stream start failed but cam started
    try {
      await withTimeout(() => obs.call("StopVirtualCam"), OBS_REQUEST_TIMEOUT_MS, "OBS StopVirtualCam");
      console.log("Cleaned up OBS Virtual Camera after start error.");
    } catch (cleanupError) {
      // console.error("Error cleaning up virtual cam:", cleanupError);
    }
    await stopRecognizeBattleResults().catch((e) =>
      console.error("Error stopping recognition after start error:", e),
    );
    return false;
  }
}

export async function stopOBSStreamingAndRecognition() {
  const result = { streamStopped: false, recognitionStopped: false };
  // Local cleanup starts immediately and is independent of OBS requests.
  const recognition = withTimeout(() => stopRecognizeBattleResults(), 10000,
    "Battle recognition shutdown").then(() => {
      result.recognitionStopped = true;
    }).catch(error => console.error("Error stopping battle recognition:", error.message));

  try {
    const state = await getOBSStreamingState({ reconnect: true });
    if (state === false) {
      result.streamStopped = true;
      console.log("OBS is already stopped; completing local cleanup.");
    } else if (obs.identified) {
      // Even if the status query failed, an explicit Stop still requests stop.
      await withTimeout(() => obs.call("StopStream"), OBS_REQUEST_TIMEOUT_MS, "OBS StopStream");
      for (let attempt = 0; attempt < 10; attempt++) {
        const stoppedState = await getOBSStreamingState();
        result.streamStopped = stoppedState === false;
        if (result.streamStopped || stoppedState === null) break;
        if (attempt < 9) await scheduler.wait(250);
      }
      if (result.streamStopped) console.log("OBS streaming stopped");
    } else {
      console.error("OBS control connection unavailable; stream shutdown is not confirmed.");
    }
  } catch (error) {
    console.error("Error stopping OBS stream:", error.message);
  }

  // Failure of either stop operation must not prevent the other cleanups.
  if (obs.identified) {
    try {
      await withTimeout(() => obs.call("StopVirtualCam"), OBS_REQUEST_TIMEOUT_MS, "OBS StopVirtualCam");
      console.log("OBS Virtual Camera stopped");
    } catch (error) {
      console.error("Error stopping OBS Virtual Camera:", error.message);
    }
  }
  await recognition;
  return result;
}

export async function launchOBS() {
  return new Promise(async (resolve, reject) => {
    await obsConnect(async (isRunning) => {
      if (isRunning) {
        console.log("OBS Studio is already running and connected.");
        resolve(true);
      } else {
        console.log(
          "OBS Studio is not running or not connected, attempting to start and connect...",
        );
        try {
          exec(
            `"${obsPath}" --disable-shutdown-check`,
            { cwd: obsDir },
            (error, stdout, stderr) => {
              if (error) {
                console.error(`Error launching OBS: ${error.message}`);
                // No reject here, as we'll try to connect anyway
              }
              // Don't wait for OBS to fully load, just proceed to connect attempt
            },
          );

          // Reset capture card DirectShow settings (fire and forget)
          if (os.platform() === "win32") {
            exec(
              `${path.join(os.homedir(), "Documents\\WebCameraConfig.exe")}`,
              { cwd: `${path.join(os.homedir(), "Documents\\")}` },
              (error, stdout, stderr) => {
                if (error)
                  console.error(
                    `Error setting camera config: ${error.message}`,
                  );
                else if (stderr)
                  console.error(`Camera config stderr: ${stderr}`);
                else console.log("Capture card config set attempt finished.");
              },
            );
          } else {
            console.log(
              "Skipping WebCameraConfig.exe execution: Not on Windows.",
            );
          }

          console.log(
            "Waiting 10 seconds before attempting to connect to OBS WebSocket...",
          );
          await scheduler.wait(10000);

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
            launchError,
          );
          resolve(false);
        }
      }
    });
  });
}

export async function closeOBS() {
  // A failed WebSocket disconnect must not skip closing the local OBS process.
  try {
    await withTimeout(() => obs.disconnect(), OBS_REQUEST_TIMEOUT_MS, "OBS disconnect");
  } catch (error) {
    console.error("Error disconnecting OBS:", error.message);
  }

  const platform = os.platform();
  const inspectCommand = platform === "win32"
    ? 'tasklist /fi "IMAGENAME eq obs64.exe" /fo csv /nh'
    : platform === "darwin" ? "pgrep -x OBS" : "pgrep -x obs";
  const closeCommand = platform === "win32" ? "taskkill /im obs64.exe"
    : platform === "darwin" ? "killall OBS" : "pkill -x obs";
  const run = (command, timeout = 10000) => new Promise(resolve => {
    exec(command, { timeout }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  let lastProcessIds = [];
  const isRunning = async (timeout) => {
    const { error, stdout } = await run(inspectCommand, timeout);
    if (platform !== "win32" && error?.code === 1) return false;
    if (error) throw error;
    lastProcessIds = platform === "win32"
      ? [...stdout.matchAll(/^\s*"obs64\.exe","(\d+)"/gim)].map(match => match[1])
      : stdout.trim().split(/\s+/).filter(Boolean);
    return platform === "win32" ? /^\s*"obs64\.exe",/im.test(stdout) : Boolean(stdout.trim());
  };

  try {
    if (!(await isRunning())) return true;
  } catch (error) {
    console.error("Could not inspect OBS process before closing:", error.message);
  }

  const { error } = await run(closeCommand);
  if (error) console.error("Error terminating OBS:", error.message);
  // The OBS window/browser sources can disappear before driver and plugin
  // teardown releases the process. Poll until exit, rather than failing after
  // the old three checks (only two seconds), and proceed as soon as it exits.
  const exitCheckStarted = Date.now();
  const exitDeadline = exitCheckStarted + OBS_PROCESS_EXIT_TIMEOUT_MS;
  let waitingLogged = false;
  try {
    while (Date.now() < exitDeadline) {
      if (!(await isRunning(Math.max(1, Math.min(10000, exitDeadline - Date.now()))))) {
        console.log(`OBS process has exited (verified after ${((Date.now() - exitCheckStarted) / 1000).toFixed(1)}s).`);
        return true;
      }
      if (!waitingLogged) {
        console.log(`Waiting up to ${OBS_PROCESS_EXIT_TIMEOUT_MS / 1000}s for OBS process cleanup (PID(s): ${lastProcessIds.join(", ") || "unknown"})...`);
        waitingLogged = true;
      }
      const remaining = exitDeadline - Date.now();
      if (remaining > 0) await scheduler.wait(Math.min(OBS_PROCESS_EXIT_POLL_MS, remaining));
    }
  } catch (error) {
    console.error("Could not verify OBS process exit:", error.message);
  }
  console.error(`OBS process exit was not confirmed after ${((Date.now() - exitCheckStarted) / 1000).toFixed(1)}s (last seen PID(s): ${lastProcessIds.join(", ") || "unknown"}). Retry Stop or close OBS manually.`);
  return false;
}

export async function hideZDXPopup() {
  try {
    if (!obs.identified) return;
    await obs.call("SetSourceFilterEnabled", {
      sourceName: "ZDX",
      filterName: "Hide",
      filterEnabled: true,
    });
  } catch (error) {
    console.error("Error in hideZDXPopup:", error);
  }
}

export async function showZDXPopup() {
  try {
    if (!obs.identified) {
      await obsConnect();
    }

    console.log("Triggering ZDX Show popup...");
    await obs.call("SetSourceFilterEnabled", {
      sourceName: "ZDX",
      filterName: "Show",
      filterEnabled: true,
    });

    // Wait for 5 seconds as requested
    await scheduler.wait(8000);

    console.log("Triggering ZDX Hide popup...");
    await obs.call("SetSourceFilterEnabled", {
      sourceName: "ZDX",
      filterName: "Hide",
      filterEnabled: true,
    });
  } catch (error) {
    console.error("Error in showZDXPopup:", error);
  }
}

const cameraMapping = {
  "federation-left": {
    Scene: 13,
    "Vertical Scene": 12,
  },
  "federation-right": {
    Scene: 14,
    "Vertical Scene": 13,
  },
  "zeon-left": {
    Scene: 12,
    "Vertical Scene": 9,
  },
  "zeon-right": {
    Scene: 11,
    "Vertical Scene": 11,
  },
};

async function setCamState(cameraName, enabled) {
  if (!cameraMapping[cameraName]) {
    console.error(`Invalid camera name: ${cameraName}`);
    return;
  }

  try {
    if (!obs.identified) {
      await obsConnect();
    }

    const scenes = cameraMapping[cameraName];
    for (const sceneName in scenes) {
      const sceneItemId = scenes[sceneName];
      await obs.call("SetSceneItemEnabled", {
        sceneName: sceneName,
        sceneItemId: sceneItemId,
        sceneItemEnabled: enabled,
      });
      // console.log(
      //   `Set '${cameraName}' in scene '${sceneName}' to ${
      //     enabled ? "enabled" : "disabled"
      //   }`
      // );
    }

    // After successfully changing the state, broadcast the update to all clients.
    if (io) {
      io.emit("camStatusUpdate", { cameraName, isEnabled: enabled });
    }
  } catch (error) {
    console.error(`Error setting camera state for ${cameraName}:`, error);
  }
}

export async function toggleCam(cameraName) {
  if (!cameraMapping[cameraName]) {
    console.error(`Invalid camera name: ${cameraName}`);
    return;
  }

  try {
    if (!obs.identified) {
      await obsConnect();
    }

    const scenes = cameraMapping[cameraName];
    // Get the current state from the first scene in the mapping
    const firstSceneName = Object.keys(scenes)[0];
    const firstSceneItemId = scenes[firstSceneName];

    const { sceneItemEnabled } = await obs.call("GetSceneItemEnabled", {
      sceneName: firstSceneName,
      sceneItemId: firstSceneItemId,
    });

    const newState = !sceneItemEnabled;
    await setCamState(cameraName, newState);
    console.log(`toggleCam: ${cameraName}`);
    return newState;
  } catch (error) {
    console.error(`Error toggling camera ${cameraName}:`, error);
    return null;
  }
}

export async function enableCam(cameraName) {
  await setCamState(cameraName, true);
}

export async function disableCam(cameraName) {
  await setCamState(cameraName, false);
}

export async function getCamStatus(cameraName) {
  if (!cameraMapping[cameraName]) {
    console.error(`Invalid camera name: ${cameraName}`);
    return null;
  }

  try {
    if (!obs.identified) {
      await obsConnect();
    }

    const scenes = cameraMapping[cameraName];
    // We only need to check one scene, as they should be in sync.
    const firstSceneName = Object.keys(scenes)[0];
    const firstSceneItemId = scenes[firstSceneName];

    const { sceneItemEnabled } = await obs.call("GetSceneItemEnabled", {
      sceneName: firstSceneName,
      sceneItemId: firstSceneItemId,
    });

    return sceneItemEnabled;
  } catch (error) {
    console.error(`Error getting status for camera ${cameraName}:`, error);
    return null;
  }
}

export async function getAllCamsStatus() {
  const statuses = {};

  if (!obs.identified) {
    return statuses;
  }

  for (const cameraName in cameraMapping) {
    statuses[cameraName] = await getCamStatus(cameraName);
  }
  return statuses;
}
