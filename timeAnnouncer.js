import schedule from "node-schedule";
import { textToSpeech } from "./ttsService.js";
import { TTSModel, Faction } from "./config.js";
import { gameState } from "./score.js";
import { IsLiveStreaming } from "./obsService.js";
import { io } from "./serverSetup.js";
import { createMessage } from "./messageService.js";

const sponsors = ["飛藝洋服", "Element of Stage"];

// Shuffle sponsors array randomly on each program run
for (let i = sponsors.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [sponsors[i], sponsors[j]] = [sponsors[j], sponsors[i]];
}

let sponsorIndex = 0;

const announcementHours = [18, 19, 20, 21, 22, 23, 0, 1, 2]; // 6pm to 2am

async function announceTime() {
  const isStreaming = await IsLiveStreaming();
  if (!isStreaming) {
    // console.log("Not live streaming, skipping time announcement.");
    return;
  }

  const now = new Date();
  const hour = now.getHours();

  if (!announcementHours.includes(hour)) {
    return;
  }

  const federationWins = gameState.totalWins[Faction.FEDERATION.value] || 0;
  const zeonWins = gameState.totalWins[Faction.ZEON.value] || 0;

  const sponsor = sponsors[sponsorIndex];
  sponsorIndex = (sponsorIndex + 1) % sponsors.length;

  const hourMap = {
    18: "六",
    19: "七",
    20: "八",
    21: "九",
    22: "十",
    23: "十一",
    0: "十二",
    1: "一",
    2: "兩",
  };
  const hourText = hourMap[hour];
  const period = hour >= 0 && hour <= 2 ? "凌晨" : "晚上";
  const timeString = `${period}${hourText}點正`;

  const text = `宇宙世紀標準時間，而家係 ${timeString}，聯邦 ${federationWins}勝，自護 ${zeonWins}勝。報時訊號由 ${sponsor} 贊助播出`;

  console.log(`Announcing: ${text}`);
  textToSpeech({
    text,
    model: TTSModel.AZURE_AI,
    voiceID: "zh-HK-HiuMaanNeural",
  });

  const msg = createMessage({
    authorName: "報時系統",
    profilePic: "images/star.png",
    message: text,
  });
  io.emit("message", msg);
}

export function startTimeAnnouncer() {
  console.log("Time announcer started. Announcements scheduled for 6pm-2am.");
  // Schedule to run at the beginning of every hour.
  schedule.scheduleJob("0 * * * *", announceTime);
}
