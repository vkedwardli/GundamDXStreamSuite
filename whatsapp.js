import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";

const TARGET_GROUP_ID = ""; // DX LCK Group

const authStrategy = new LocalAuth();

// Patch the logout method to catch the EBUSY error on Windows
const originalLogout = authStrategy.logout.bind(authStrategy);
authStrategy.logout = async () => {
  try {
    await originalLogout();
  } catch (err) {
    console.error("Error during LocalAuth logout (ignored to prevent crash):", err);
  }
};

const client = new Client({ authStrategy });
const clientReady = new Promise((resolve) => {
  client.on("ready", () => {
    console.log("Client is ready!");
    resolve();
  });
});
const dxChatPromise = clientReady.then(() =>
  client.getChatById(TARGET_GROUP_ID)
);

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Send a text message to the target group.
export async function sendTextToDXGroup(
  message,
  { withTyping = false, typingDurationMs = 1800, pauseAfterMs = 800 } = {}
) {
  await clientReady; // Ensure client is ready before sending
  const chat = await dxChatPromise;

  if (withTyping && chat) {
    try {
      await chat.sendStateTyping();
      await delay(typingDurationMs);
      await chat.clearState(); // stop typing indicator
    } catch (err) {
      console.error("Failed to send typing state:", err);
    }
  }

  try {
    const res = await client.sendMessage(TARGET_GROUP_ID, message, {
      sendSeen: false,
    });
    if (pauseAfterMs > 0) await delay(pauseAfterMs);
    return res;
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err);
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
  if (reason && reason.stack && reason.stack.includes("whatsapp-web.js")) {
    console.error("Caught unhandled rejection from WhatsApp library:", reason);
  } else {
    // For other rejections, you might want to log them or handle them differently
    // but at least we prevent the crash.
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  }
});

process.on("uncaughtException", (err) => {
  if (err && err.stack && err.stack.includes("whatsapp-web.js")) {
    console.error("Caught uncaught exception from WhatsApp library:", err);
  } else {
    console.error("Uncaught Exception:", err);
    // For non-WhatsApp errors, it might be safer to exit, but we'll keep it running for now
    // as per user request to "not crash".
  }
});

client.initialize();
