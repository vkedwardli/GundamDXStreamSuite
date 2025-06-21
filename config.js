import dotenv from "dotenv";
dotenv.config();

export const isDev = process.env.NODE_ENV === "development";

// Path to OBS directory and executable
export const obsDir = "C:\\\\Program Files\\\\obs-studio\\\\bin\\\\64bit";
export const obsPath = `${obsDir}\\\\obs64.exe`; // Full path to executable

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

// Export environment variables
export const CLIENT_ID = process.env.CLIENT_ID;
export const CLIENT_SECRET = process.env.CLIENT_SECRET;
export const OBS_PASSWORD = process.env.OBS_PASSWORD;
export const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID;
export const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
