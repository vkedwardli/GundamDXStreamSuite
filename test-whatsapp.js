import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";
import { WA_TEST_GROUP_ID } from "./config.js";

console.log("Starting WhatsApp Diagnostic Script...");
console.log("NOTE: This test uses a temporary 'diagnostic-test' session.");
console.log(
  "If this works (you see a QR code or browser), your main '.wwebjs_auth' folder is likely corrupt.",
);

// Use a unique ID to avoid loading the potentially broken main profile
const authStrategy = new LocalAuth({ clientId: "diagnostic-test" });

console.log(
  "Initializing Client with LocalAuth (clientId: diagnostic-test)...",
);

const client = new Client({
  authStrategy,
  puppeteer: {
    handleSIGINT: false,
  },
});

client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("Client is ready!");
  console.log(`Attempting to send test message to ${WA_TEST_GROUP_ID}...`);
  try {
    await client.sendMessage(
      WA_TEST_GROUP_ID,
      "Diagnostic test message from GundamDXStreamSuite.",
    );
    console.log(
      "Test message sent successfully! Waiting 5 seconds to ensure sync...",
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    process.exit(0);
  } catch (err) {
    console.error("Failed to send test message:", err);
    process.exit(1);
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
});

// Timeout check
setTimeout(() => {
  console.log("--- TIMEOUT CHECK ---");
  console.log("If you haven't seen 'Client is ready!' or a QR code yet,");
  console.log(
    "it's likely the session data is corrupted or Chrome can't start.",
  );
  console.log("Try deleting the '.wwebjs_auth' and '.wwebjs_cache' folders.");
}, 30000);
