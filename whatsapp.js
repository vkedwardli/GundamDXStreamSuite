import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";
export { WA_PUBLIC_GROUP_ID, WA_TEST_GROUP_ID } from "./config.js";

const authStrategy = new LocalAuth();

// Patch the logout method to catch the EBUSY error on Windows
const originalLogout = authStrategy.logout.bind(authStrategy);
authStrategy.logout = async () => {
  try {
    await originalLogout();
  } catch (err) {
    console.error(
      "Error during LocalAuth logout (ignored to prevent crash):",
      err,
    );
  }
};

console.log("Initializing WhatsApp client...");
export const client = new Client({
  authStrategy,
  puppeteer: {
    handleSIGINT: false,
  },
});

client.on("loading_screen", (percent, message) => {
  console.log("WhatsApp Loading:", percent, message);
});

client.on("authenticated", () => {
  console.log("WhatsApp Authenticated");
});

client.on("auth_failure", (msg) => {
  console.error("WhatsApp Auth Failure:", msg);
});

const clientReady = new Promise((resolve) => {
  const timeout = setTimeout(() => {
    console.error(
      "WARNING: WhatsApp client has not become ready after 60 seconds.",
    );
    console.error(
      "Possible fixes: 1. Delete .wwebjs_auth and .wwebjs_cache folders. 2. Ensure internet connection. 3. Check for zombie Chrome processes.",
    );
  }, 60000);

  client.on("ready", () => {
    clearTimeout(timeout);
    console.log("WhatsApp Client is ready!");
    startHumanPresenceSimulation(client);
    resolve();
  });
});

/**
 * Simulates human-like presence on WhatsApp.
 * Instead of a fixed interval, it uses variable delays and
 * respects "sleeping hours" to appear more natural.
 */
function startHumanPresenceSimulation(client) {
  const MIN_DELAY = 45000; // 45s
  const MAX_DELAY = 300000; // 5m

  let isOnline = false;

  const updatePresence = async () => {
    try {
      // Logic to simulate sessions:
      // Humans tend to stay online or offline for periods of time.
      // 80% chance to maintain current state, 20% chance to toggle.
      const shouldToggle = Math.random() < 0.2;

      if (shouldToggle || !isOnline) {
        // 70% chance to be "Online" when toggling to simulate active usage
        const nextStateIsOnline = Math.random() < 0.7;

        if (nextStateIsOnline !== isOnline) {
          if (nextStateIsOnline) {
            await client.sendPresenceAvailable();
            // console.log("WhatsApp Simulation: Now Online");
          } else {
            await client.sendPresenceUnavailable();
            // console.log("WhatsApp Simulation: Now Offline");
          }
          isOnline = nextStateIsOnline;
        }
      }
    } catch (e) {
      console.warn("WhatsApp Simulation Warning:", e.message);
    }

    // Schedule next update with a random delay to avoid robotic patterns
    const nextDelay =
      Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
    setTimeout(updatePresence, nextDelay);
  };

  updatePresence();
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Send a text message to the target group.
export async function sendTextToDXGroup(
  message,
  {
    withTyping = false,
    typingDurationMs = 1800,
    pauseAfterMs = 800,
    groupId = WA_PUBLIC_GROUP_ID,
  } = {},
) {
  await clientReady; // Ensure client is ready before sending

  // Ensure we are online before sending
  try {
    await client.sendPresenceAvailable();
  } catch (err) {
    console.warn(
      "Failed to set presence to available before sending:",
      err.message,
    );
  }

  if (withTyping) {
    try {
      const chat = await client.getChatById(groupId);
      await chat.sendStateTyping();
      // Wait for the requested typing duration
      await delay(typingDurationMs);
      // We don't call clearState() here, as sending the message or
      // calling clearState later is more natural.
      // WhatsApp often clears it automatically upon message receipt.
    } catch (err) {
      console.warn(
        `Warning: Failed to set typing state for ${groupId} (sending message anyway):`,
        err.message,
      );
    }
  }

  try {
    const res = await client.sendMessage(groupId, message, {
      sendSeen: false,
    });

    // Explicitly clear state after message is sent if it's still there
    if (withTyping) {
      try {
        const chat = await client.getChatById(groupId);
        await chat.clearState();
      } catch (e) {}
    }

    if (pauseAfterMs > 0) await delay(pauseAfterMs);
    return res;
  } catch (err) {
    console.error(`Failed to send WhatsApp message to ${groupId}:`, err);
    return null;
  }
}

client.on("qr", (qr) => {
  // Generate and scan this code with your phone
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
});

client.on("disconnected", (reason) => {
  console.log("WhatsApp Client disconnected:", reason);
});

client.on("error", (err) => {
  console.error("WhatsApp Client Error:", err);
});

// client.on("message", async (msg) => {
//   if (msg.body == "!ping") {
//     msg.reply("pong");
//     return;
//   }

//   // Log the group id whenever a message comes from a group (e.g., send one from another number)
//   const chat = await msg.getChat();
//   if (chat.isGroup) {
//     console.log("Group ID:", chat.id._serialized);
//   }
// });

// Prevent process from crashing on unhandled rejections or exceptions from the library
process.on("unhandledRejection", (reason, promise) => {
  if (
    reason &&
    ((reason.stack && reason.stack.includes("whatsapp-web.js")) ||
      reason.message)
  ) {
    console.error("Caught unhandled rejection from WhatsApp library:");
    console.error("Message:", reason.message || "No message");
    console.error("Stack:", reason.stack || "No stack trace");
  } else {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  }
});

process.on("uncaughtException", (err) => {
  if (err && err.stack && err.stack.includes("whatsapp-web.js")) {
    console.error("Caught uncaught exception from WhatsApp library:", err);
  } else {
    console.error("Uncaught Exception:", err);
  }
});

console.log("Calling WhatsApp client.initialize()...");
client.initialize();
