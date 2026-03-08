import { startRecognizeBattleResults } from "./score.js";

console.log("Starting OCR Test Mode...");
console.log("This will monitor for 'GAME OVER' and 'BANPRESTO' logos.");
console.log("Press Ctrl+C to stop.");

startRecognizeBattleResults()
  .then(() => {
    console.log("OCR engine initialized.");
  })
  .catch((err) => {
    console.error("Failed to start OCR:", err);
  });
