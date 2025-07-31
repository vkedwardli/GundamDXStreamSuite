# Gundam DX Stream Suite

<p align=center><img src="https://github.com/vkedwardli/GundamDXStreamSuite/blob/main/images/lckzaku.png" width="300" /></p>
<img src="https://github.com/vkedwardli/GundamDXStreamSuite/blob/main/docs/setup.jpeg" />
<img src="https://github.com/vkedwardli/GundamDXStreamSuite/blob/main/docs/dxop.jpeg" />

Gundam DX Stream Suite is an automation tool for live streaming "Mobile Suit Gundam: Federation vs. Zeon DX" arcade games. It's designed for a dual-perspective setup (Federation and Zeon), automating everything from stream creation to score tracking.

### Watch our live stream: [荔枝角 GundamDX on YouTube](https://www.youtube.com/@%E8%8D%94%E6%9E%9D%E8%A7%92GundamDX)

###### **Disclaimer:** This tool is built for a specific arcade streaming setup. Using it for other games or on different systems will require technical adjustments.

## Key Features

- **Automated Dual Streaming:** Automatically creates and manages two separate YouTube live streams (one for each faction) with a single click.
- **AI-Powered Scorekeeping:** Uses screen recognition (OCR) to automatically detect the winner of each match, keeping track of scores, win rates, and streaks.
- **Unified Chat & TTS:** Combines the live chat from both streams into one view. Viewers can use chat commands like `!say` to have their messages read out loud by a Text-to-Speech voice.
- **Simple Control Panel:** A touch-friendly web interface to start/stop streams, view logs, and control features like TTS.

## Getting Started

### Prerequisites

- **Node.js**
- **FFmpeg** (for video processing)
- **OBS Studio** with the WebSocket and Aitum Vertical plugin enabled.
- A **Google Cloud Project** with the YouTube Data API enabled to allow the tool to manage your streams.

### Setup

1.  **Download the code:**
    ```bash
    git clone https://github.com/vkedwardli/GundamDXStreamSuite.git
    cd GundamDXStreamSuite
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Configure:**
    - Create a `.env` file by copying from `.env.example`.
    - Fill in your details, such as Google API credentials and your OBS WebSocket password.
4.  **Authorize with YouTube:**
    - Run the app for the first time: `node index.js`.
    - Follow the on-screen link to log in with your Google account and allow access. A `token.json` file will be saved for future use.

### Running the Application

```bash
node index.js
```

Once running, open the control panel in your browser to manage the stream.

## For Developers

This project is highly customizable but contains hardcoded values specific to the original setup (e.g., screen coordinates for OCR in `score.js`, Windows paths in `systemUtils.js`). If you plan to adapt this project, you will need to modify these values to fit your environment.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0).
