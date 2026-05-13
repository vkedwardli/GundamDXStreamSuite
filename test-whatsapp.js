import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";
import path from "path";
import { fileURLToPath } from "url";
import { WA_TEST_GROUP_ID } from "./config.js";

console.log("Starting WhatsApp Diagnostic Script...");
console.log("NOTE: This test uses a temporary 'diagnostic-test' session.");
console.log(
  "If this works (you see a QR code or browser), your main '.wwebjs_auth' folder is likely corrupt.",
);

// Use a unique ID to avoid loading the potentially broken main profile
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_CLIENT_ID = "diagnostic-test";
const AUTH_DATA_PATH = path.join(__dirname, ".wwebjs_auth");
const authStrategy = new LocalAuth({
  clientId: AUTH_CLIENT_ID,
  dataPath: AUTH_DATA_PATH,
});

console.log(
  `Initializing Client with LocalAuth (clientId: ${AUTH_CLIENT_ID})...`,
);
console.log(
  `Auth data folder: ${path.join(AUTH_DATA_PATH, `session-${AUTH_CLIENT_ID}`)}`,
);

const client = new Client({
  authStrategy,
  puppeteer: {
    handleSIGINT: false,
  },
});

const ACK_NAMES = {
  "-1": "ERROR",
  0: "PENDING",
  1: "SERVER",
  2: "DEVICE",
  3: "READ",
  4: "PLAYED",
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(exitCode) {
  clearTimeout(timeoutCheck);
  console.log("Closing WhatsApp client cleanly...");
  try {
    await client.destroy();
  } catch (err) {
    console.warn("Warning: failed to destroy WhatsApp client:", err.message);
  }
  process.exit(exitCode);
}

async function printKnownGroups() {
  const chats = await client.getChats();
  const groups = chats.filter((chat) => chat.isGroup);
  console.log(`Known groups on this WhatsApp session: ${groups.length}`);
  groups.forEach((chat) => {
    console.log(`- ${chat.name}: ${chat.id._serialized}`);
  });
}

client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
});

client.on("message_ack", (message, ack) => {
  console.log(
    `Message ACK: ${message.id._serialized} -> ${ACK_NAMES[ack] ?? ack}`,
  );
});

client.on("ready", async () => {
  console.log("Client is ready!");
  if (!WA_TEST_GROUP_ID) {
    console.error("WA_TEST_GROUP_ID is empty. Check your .env file.");
    await shutdown(1);
  }

  console.log(`Attempting to send test message to ${WA_TEST_GROUP_ID}...`);
  try {
    let chat;
    try {
      chat = await client.getChatById(WA_TEST_GROUP_ID);
    } catch (err) {
      console.error(`Could not resolve chat ${WA_TEST_GROUP_ID}:`, err.message);
      await printKnownGroups();
      await shutdown(1);
    }

    if (!chat?.isGroup) {
      console.error(`${WA_TEST_GROUP_ID} resolved, but it is not a group chat.`);
      await printKnownGroups();
      await shutdown(1);
    }

    console.log(`Resolved group: ${chat.name} (${chat.id._serialized})`);

    const sentMessage = await client.sendMessage(
      chat.id._serialized,
      `Diagnostic test message from GundamDXStreamSuite. ${new Date().toISOString()}`,
      { waitUntilMsgSent: true },
    );

    if (!sentMessage) {
      console.error(
        "sendMessage returned no message object. The chat id is probably not valid for this session.",
      );
      await printKnownGroups();
      await shutdown(1);
    }

    console.log(`Message queued: ${sentMessage.id._serialized}`);
    console.log(
      `Initial ACK: ${ACK_NAMES[sentMessage.ack] ?? sentMessage.ack}. Waiting 20 seconds for delivery ACK...`,
    );
    await delay(20000);
    await shutdown(0);
  } catch (err) {
    console.error("Failed to send test message:", err);
    await shutdown(1);
  }
});

client.on("loading_screen", (percent, message) => {
  console.log("LOADING SCREEN:", percent, message);
});

client.on("change_state", (state) => {
  console.log("STATE CHANGE:", state);
});

client.on("authenticated", () => {
  console.log("Client is authenticated!");
});

client.on("auth_failure", (msg) => {
  console.error("AUTHENTICATION FAILURE:", msg);
});

client.on("disconnected", (reason) => {
  console.log("Client was disconnected", reason);
});

console.log("Calling client.initialize()...");
client.initialize().catch((err) => {
  console.error("Error during initialization:", err);
  process.exit(1);
});

// Timeout check
const timeoutCheck = setTimeout(() => {
  console.log("--- TIMEOUT CHECK ---");
  console.log("If you haven't seen 'Client is ready!' or a QR code yet,");
  console.log(
    "it's likely the session data is corrupted or Chrome can't start.",
  );
  console.log("Try deleting the '.wwebjs_auth' and '.wwebjs_cache' folders.");
}, 30000);

process.on("SIGINT", () => {
  shutdown(130);
});
