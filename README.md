# GundamDXStreamSuite
<p align=center><img src="https://github.com/vkedwardli/GundamDXStreamSuite/blob/main/lckzaku.png" width="300" /></p>
<img src="https://github.com/vkedwardli/GundamDXStreamSuite/blob/main/hardware/setup.jpeg" />
<img src="https://github.com/vkedwardli/GundamDXStreamSuite/blob/main/hardware/dxop.jpeg" />

GundamDXStreamSuite is a comprehensive automation tool designed to manage and enhance live streaming of "Mobile Suit Gundam: Federation vs. Zeon DX" arcade game sessions, particularly for setups involving dual perspectives (Federation and Zeon). It automates stream creation on YouTube, OBS control, live chat aggregation, TTS (Text-to-Speech) from chat commands, and game outcome detection via OCR.

**Disclaimer:** This project is tailored to a specific hardware and software setup used for streaming Gundam DX from an arcade environment. While core concepts might be adaptable, many features (especially screen capture coordinates, Windows-specific utilities, and hardcoded paths) will require significant modification for other use cases or environments.

## Core Features

1.  **Dual YouTube Live Stream Management (Federation vs. Zeon):**

    - **Automated Stream Creation:** Creates two distinct YouTube live events (Federation & Zeon) with predefined titles, descriptions (including links to switch perspectives), and gaming category.
    - **Stream Binding:** Binds broadcasts to pre-existing YouTube live stream configurations in YouTube Studio.
    - **Dynamic Title Updates:** Updates video titles with the current date.
    - **Public/Unlisted Control:** Allows starting streams as public or unlisted.

2.  **OBS Orchestration:**

    - **Automated OBS Launch & Termination:** Launches OBS Studio (if not running), connects via WebSocket and can close OBS after streaming.
    - **Automated Stream Start/Stop:** Controls OBS stream output.
    - **Virtual Camera Control:** Manages the OBS Virtual Camera, used for game capture by the scoring module.

3.  **"Gundam DX" Battle Score & Outcome Recognition:**

    - **Screen Region Capture (FFmpeg):** Captures specific game screen regions via OBS Virtual Camera, crops relevant areas (e.g., player status for both factions), and stacks them for OCR.
    - **Automated Game Outcome Determination:** Uses Tesseract.js to detect and determines winner (Federation/Zeon) or draw, tracks battle stats, win ratios, and streaks.
    - **Debounced Processing:** Buffers OCR results to handle staggered detections.

4.  **Unified Live Chat Aggregation:**

    - **Dual Chat Fetching:** Fetches YouTube live chat messages from both faction streams.
    - **Message Merging:** (Intended for display in `comments.html` for displaying in both live streams)
    - **Duplicate Prevention:** Basic caching to avoid displaying identical messages received close together.

5.  **Interactive TTS (Text-to-Speech) from Chat:**

    - **Chat Commands:** Supports `!say`, `!gossip`, `!anchor` for TTS.
    - **Multiple TTS Voices/Models:** Configured for Azure AI (Cantonese voices) and MiniMax AI.
    - **TTS Preprocessing (Azure):** Custom text replacements for Azure TTS to improve Cantonese slang pronunciation.
    - **Audio Queue & Rate Limiting:** Manages TTS requests sequentially with API rate limits.
    - **Megaphone Toggle:** Global TTS enable/disable via a control interface.

6.  **Web-Based Control Interface (`control.html`):**

    - **Stream Control:** Buttons for starting (Public/Unlisted) and stopping streams.
    - **Real-time Console Output:** Displays server-side logs.
    - **QR Code Display:** Shows QR codes for live stream URLs.
    - **Megaphone Control:** UI to toggle TTS.

7.  **System & Environment Specifics (Requires Adaptation for General Use):**

    - **DXOP Screen:** Launches Chrome in kiosk mode for `control.html`.
    - **Windows-Specific Utilities:** Includes OBS launch path, `taskkill`, a specific `WebCameraConfig.exe` for capture card setup, and Bluetooth speaker (`btcom`, `btdiscovery`) commands.

8.  **Additional Features:**
    - **Scheduled Stream Stop:** Automatically stops streams at a configured time.
    - **Viewer Count Aggregation:** Sums viewer counts from both streams.
    - **OAuth2 Token Management:** Handles YouTube API token storage and refresh.

## Prerequisites

- **Node.js:** v18.x or later
- **FFmpeg:** Must be installed and accessible in the system's PATH.
- **OBS Studio:** Installed, with the OBS WebSocket and Aitum Vertical plugin.
- **Specific Hardware (for some features):**
  - Capture card compatible with `WebCameraConfig.exe` (Optional, just for color tuning)
  - Bluetooth speaker with known MAC address (In case you are using Bluetooth speaker like me)
- **Google Cloud Project:** With YouTube Data API v3 enabled. OAuth 2.0 credentials (`client_id`, `client_secret`) are required.
- **Pre-configured YouTube Live Streams:** Two persistent live stream setups in YouTube Studio (e.g., named "OBS Federation" and "OBS Zeon") for binding.

## Setup

1.  **Clone the repository:**

    ```bash
    git clone <repository-url>
    cd GundamDXStreamSuite
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**

    - Copy `.env.example` to `.env`.
    - Fill in the required values in `.env`:
      - `CLIENT_ID`: Your Google Cloud Project's OAuth 2.0 Client ID.
      - `CLIENT_SECRET`: Your Google Cloud Project's OAuth 2.0 Client Secret.
      - `OBS_PASSWORD`: Your OBS WebSocket server password.
      - `MINIMAX_GROUP_ID` (Optional): Your MiniMax Group ID for TTS.
      - `MINIMAX_API_KEY` (Optional): Your MiniMax API Key for TTS.
      - (Add any other environment variables your current setup uses)

4.  **Authorize YouTube API:**

    - Run the application for the first time: `node index.js`
    - Follow the console instructions: open the provided URL in a browser, authorize the application, and you'll be redirected to `http://localhost:3000/oauth2callback`.
    - A `token.json` file will be created in the project root, storing your OAuth tokens.

5.  **OBS Configuration:**

    - Ensure OBS WebSocket server is enabled (usually under Tools -> WebSocket Server Settings).
    - Set the server password and update it in your `.env` file.
    - Set up an "OBS Virtual Camera" source in OBS that captures your Gundam DX game feed. The `score.js` module relies on this for OCR. The FFmpeg commands in `score.js` expect specific resolutions and crop regions from this virtual camera feed.

6.  **Review Hardcoded Paths & Settings:**
    - **`config.js`**: Check `obsDir` and `obsPath` for your OBS installation.
    - **`score.js`**: The `ffmpegArgs` within `captureStackedImage()` contain hardcoded crop coordinates (`crop=w:h:x:y`). These **MUST** be adjusted to match your specific game resolution and the layout of information on your screen as captured by the OBS Virtual Camera.
    - **`systemUtils.js`**:
      - `startDXOPScreen()`: Check `chromePath`.
      - `connectSpeaker()`: Update speaker name and MAC address if using this feature.
      - The path to `WebCameraConfig.exe` is hardcoded.

## Running the Application

```bash
node index.js
```

## Key Modules

- `index.js`: Main application orchestrator.
- `config.js`: Shared configurations, constants, and environment variable access.
- `serverSetup.js`: HTTP server, Socket.IO, static file serving, OAuth callback.
- `youtubeService.js`: YouTube API interactions, stream management.
- `obsService.js`: OBS WebSocket control, stream/virtual cam management, OBS app launch/close.
- `score.js`: Gundam DX game outcome detection via FFmpeg and Tesseract OCR.
- `chatService.js`: YouTube live chat fetching, processing, and viewer count.
- `ttsService.js`: Text-to-Speech processing using Azure/MiniMax.
- `systemUtils.js`: Miscellaneous utilities (DXOP screen, Bluetooth speaker).
- `control.html`: Web-based control panel.
- `comments.html`: (Assumed) HTML page for displaying fused chat messages.

## Customization & Adaptation

- **OCR Coordinates (`score.js`):** This is the most critical part to adapt. You **must** adjust the `ffmpegArgs` (crop dimensions and positions) in `captureStackedImage()` to match your game's screen layout and resolution.
- **Windows-Specific Utilities:** Functions in `systemUtils.js` and parts of `obsService.js` related to launching/closing OBS and `WebCameraConfig.exe` are Windows-specific. These will need to be removed or adapted for other operating systems.
- **Hardcoded Paths:** Review all files for hardcoded paths and adjust as needed.
- **TTS Voices/Models:** Modify `ttsService.js` and `chatService.js` if you want to use different TTS engines or voices.
- **YouTube Stream Details:** Customize titles, descriptions, and other settings in `youtubeService.js`.

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0).
