import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";

export const PUBLIC_GROUP_ID = ""; // DX LCK Group
export const TEST_GROUP_ID = ""; // Internal Testing Group

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
    resolve();
  });
});

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Send a text message to the target group.
export async function sendTextToDXGroup(
  message,
  {
    withTyping = false,
    typingDurationMs = 1800,
    pauseAfterMs = 800,
    groupId = PUBLIC_GROUP_ID,
  } = {},
) {
  await clientReady; // Ensure client is ready before sending

  if (withTyping) {
    try {
      const chat = await client.getChatById(groupId);
      await chat.sendStateTyping();
      await delay(typingDurationMs);
      await chat.clearState(); // stop typing indicator
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
