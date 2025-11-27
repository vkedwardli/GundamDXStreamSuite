import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";

const TARGET_GROUP_ID = ""; // DX LCK Group

const client = new Client({ authStrategy: new LocalAuth() });
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

  const res = await client.sendMessage(TARGET_GROUP_ID, message);
  if (pauseAfterMs > 0) await delay(pauseAfterMs);
  return res;
}

client.on("qr", (qr) => {
  // Generate and scan this code with your phone
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
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

client.initialize();
