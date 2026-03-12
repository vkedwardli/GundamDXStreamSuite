import dotenv from "dotenv";
dotenv.config();

export const isDev = process.env.NODE_ENV === "development";

import os from "os";

// Path to OBS directory and executable
let obsDir = "";
let obsPath = "";

if (os.platform() === "win32") {
  obsDir = "C:\\\\Program Files\\\\obs-studio\\\\bin\\\\64bit";
  obsPath = `${obsDir}\\\\obs64.exe`;
} else if (os.platform() === "darwin") {
  obsDir = "/Applications/OBS.app/Contents/MacOS";
  obsPath = `${obsDir}/obs`;
} else {
  // Linux or other fallback
  obsDir = "/usr/bin"; // standard linux location
  obsPath = "obs";
}

export { obsDir, obsPath };

// OAuth 2.0 Scopes and Token Path
export const SCOPES = ["https://www.googleapis.com/auth/youtube"];
export const TOKEN_PATH = "token.json";

// Define Faction enum with additional properties
export const Faction = Object.freeze({
  FEDERATION: {
    value: "federation",
    streamSnippetName: "OBS Federation",
    displayName: "連邦",
  },
  ZEON: {
    value: "zeon",
    streamSnippetName: "OBS Zeon",
    displayName: "自護",
  },
});

export const TTSModel = Object.freeze({
  MINIMAX_AI: "MINIMAX_AI",
  AZURE_AI: "AZURE_AI",
});

export const Megaphone = Object.freeze({
  ENABLED: { enabled: true, icon: "🔊", gossip: "💁", anchor: "🎤" },
  MUTED: { enabled: false, icon: "🔇", gossip: "😶", anchor: "🔕" },
});

// Dictionary for bypassing YouTube auto-moderation
// Key: The word to filter for YouTube
// Value: The replacement word to actually send
export const MODERATION_FILTERS = {
  死: "歹匕",
};

// Export environment variables
export const CLIENT_ID = process.env.CLIENT_ID;
export const CLIENT_SECRET = process.env.CLIENT_SECRET;
export const OBS_PASSWORD = process.env.OBS_PASSWORD;
export const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID;
export const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
export const WA_PUBLIC_GROUP_ID = process.env.WA_PUBLIC_GROUP_ID;
export const WA_TEST_GROUP_ID = process.env.WA_TEST_GROUP_ID;
