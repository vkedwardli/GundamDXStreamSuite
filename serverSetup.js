import http from "http";
import url from "url";
import path, { join } from "path";
import fs from "fs/promises";
import { Server } from "socket.io";
import { oAuth2Client } from "./youtubeService.js";
import { TOKEN_PATH as YOUTUBE_TOKEN_PATH } from "./config.js";
import { getFormattedTime } from "./messageService.js";

import { EventEmitter } from "events";
const __dirname = import.meta.dirname;

export let io; // Export io to be used in other modules if needed
export const internalEvents = new EventEmitter();

const qrArtRegex = /^[\s▄▀█]+$/;

function formatConsoleArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (typeof arg === "object") {
    return JSON.stringify(arg, null, 2);
  }
  return String(arg);
}

function isQrArt(message) {
  const compactMessage = message.replace(/\r?\n/g, "");
  return compactMessage.length > 0 && qrArtRegex.test(compactMessage);
}

function buildTimestampedConsoleArgs(args) {
  const message = args.map(formatConsoleArg).join(" ");
  const trimmedMessage = message.trim();

  if (trimmedMessage.length === 0 || isQrArt(trimmedMessage)) {
    return { emittedMessage: message, consoleArgs: args };
  }

  const timestamp = `${getFormattedTime()}:`;
  const timestampedMessage = trimmedMessage
    .split(/\r?\n/)
    .map((line) => `${timestamp} ${line}`)
    .join("\n");

  return {
    emittedMessage: timestampedMessage,
    consoleArgs: [timestampedMessage],
  };
}

export function setupServer(onClientConnected) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === "/oauth2callback") {
      const code = parsedUrl.query.code;
      if (code) {
        try {
          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          await fs.writeFile(YOUTUBE_TOKEN_PATH, JSON.stringify(tokens));
          console.log("YouTube token stored to", YOUTUBE_TOKEN_PATH);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authorization successful! You can close this window.</h1>"
          );
        } catch (err) {
          res.writeHead(500);
          res.end("Error retrieving YouTube tokens");
          console.error("Error getting YouTube tokens:", err);
        }
      } else {
        res.writeHead(400);
        res.end("No authorization code provided for YouTube OAuth");
      }
    } else if (parsedUrl.pathname === "/remote") {
      const filePath = path.join(__dirname, "remote.html");
      try {
        const data = await fs.readFile(filePath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      } catch (err) {
        res.writeHead(404);
        res.end("Remote control page not found.");
      }
    } else {
      // Serve static files
      const requestedPath =
        parsedUrl.pathname === "/"
          ? "comments.html"
          : parsedUrl.pathname.slice(1);
      // Basic path sanitization to prevent directory traversal
      if (requestedPath.includes("..")) {
        res.writeHead(400);
        res.end("Invalid path");
        return;
      }
      const filePath = path.join(__dirname, requestedPath);
      const extname = path.extname(filePath).toLowerCase();
      const contentTypes = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css", // Added CSS
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon", // Added ICO for favicon
      };

      if (Object.keys(contentTypes).includes(extname)) {
        try {
          const data = await fs.readFile(filePath);
          res.writeHead(200, {
            "Content-Type": contentTypes[extname],
          });
          res.end(data);
        } catch (err) {
          // console.error("Error serving file:", filePath, err.code); // More detailed log
          if (err.code === "ENOENT") {
            res.writeHead(404);
            res.end("File not found");
          } else {
            res.writeHead(500);
            res.end("Server error");
          }
        }
      } else {
        res.writeHead(404);
        res.end("Resource Not Found or Filetype Not Supported");
      }
    }
  });

  io = new Server(server);

  // Override console.log to send to all clients via Socket.IO
  const originalConsoleLog = console.log;
  console.log = function (...args) {
    const { emittedMessage, consoleArgs } = buildTimestampedConsoleArgs(args);
    if (io) {
      // Check if io is initialized
      io.emit("console", emittedMessage);
    }
    originalConsoleLog.apply(console, consoleArgs);
  };
  // Also override console.error
  const originalConsoleError = console.error;
  console.error = function (...args) {
    const { emittedMessage, consoleArgs } = buildTimestampedConsoleArgs(args);
    if (io) {
      io.emit("console_error", emittedMessage); // Use a different event for errors
    }
    originalConsoleError.apply(console, consoleArgs);
  };

  io.on("connection", (client) => {
    console.log("Client connected via Socket.IO");
    if (onClientConnected) {
      onClientConnected(client, io); // Pass io as well
    }
    client.on("disconnect", () => {
      console.log("Client disconnected from Socket.IO");
    });
  });

  server.listen(3000, () =>
    console.log("HTTP Server with Socket.IO running on port 3000")
  );

  return { server, io };
}
