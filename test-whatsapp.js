import "dotenv/config";

// Keep the diagnostic login isolated from the server's production session.
process.env.WA_CLIENT_ID =
  process.env.WA_TEST_CLIENT_ID?.trim() || "diagnostic-test";
process.env.WA_DISABLE_AUTO_START = "1";

const { client, WA_TEST_GROUP_ID } = await import("./whatsapp.js");

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

let shuttingDown = false;
let timeoutCheck;

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(timeoutCheck);
  console.log("Closing WhatsApp client cleanly...");
  try {
    await client.destroy();
  } catch (error) {
    console.warn("Warning: failed to destroy WhatsApp client:", error.message);
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

async function waitForTestGroup(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chat = await client.getChatById(WA_TEST_GROUP_ID);
    if (chat) return chat;
    await delay(2000);
  }
  return null;
}

client.on("message_ack", (message, ack) => {
  console.log(
    `Message ACK: ${message.id._serialized} -> ${ACK_NAMES[ack] ?? ack}`,
  );
});

client.on("authenticated", () => {
  console.log("Client is authenticated!");
});

client.on("auth_failure", (message) => {
  console.error("AUTHENTICATION FAILURE:", message);
});

client.on("disconnected", (reason) => {
  console.log("Client was disconnected:", reason);
});

client.on("error", (error) => {
  console.error("WhatsApp diagnostic error:", error);
});

console.log("Starting WhatsApp wacli diagnostic script...");
console.log(`wacli binary: ${client.binary}`);
console.log(`Diagnostic auth store: ${client.storeDir}`);
console.log("If a QR code appears, scan it from WhatsApp > Linked Devices.");

timeoutCheck = setTimeout(() => {
  console.log("--- LOGIN CHECK ---");
  console.log("The diagnostic is still waiting for WhatsApp.");
  console.log("Scan the QR code above, or run `wacli doctor --connect` if already linked.");
}, 30000);

process.on("SIGINT", () => {
  shutdown(130);
});
process.on("SIGTERM", () => {
  shutdown(143);
});

try {
  if (!WA_TEST_GROUP_ID?.endsWith("@g.us")) {
    throw new Error("WA_TEST_GROUP_ID is empty or is not a WhatsApp group JID.");
  }

  console.log("Initializing the same WhatsApp adapter used by the application...");
  await client.initialize();
  clearTimeout(timeoutCheck);
  console.log(`Client is ready through wacli ${client.version}.`);

  console.log(`Waiting for the testing group ${WA_TEST_GROUP_ID}...`);
  const chat = await waitForTestGroup();
  if (!chat?.isGroup) {
    console.error(`Could not resolve testing group ${WA_TEST_GROUP_ID}.`);
    await printKnownGroups();
    await shutdown(1);
  }

  console.log(`Resolved group: ${chat.name} (${chat.id._serialized})`);
  const sentMessage = await client.sendMessage(
    chat.id._serialized,
    `wacli migration test from GundamDXStreamSuite. ${new Date().toISOString()}`,
    { waitUntilMsgSent: true },
  );

  console.log(`Message accepted by WhatsApp: ${sentMessage.id._serialized}`);
  console.log(
    `Initial ACK: ${ACK_NAMES[sentMessage.ack] ?? sentMessage.ack}. Please confirm the message is visible in the testing group.`,
  );
  await delay(5000);
  await shutdown(0);
} catch (error) {
  console.error("WhatsApp diagnostic failed:", error);
  await shutdown(1);
}
