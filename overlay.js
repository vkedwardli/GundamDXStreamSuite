import { app, BrowserWindow, screen } from 'electron';
import path from 'path';

let win;

function createWindow() {
  const iconPath = path.join(process.cwd(), 'images', 'lckzaku.png');
  const { bounds } = screen.getPrimaryDisplay();

  // Explicitly set App User Model ID for Windows Taskbar grouping/icon
  if (process.platform === 'win32') {
    app.setAppUserModelId("com.gundamdx.streamsuite");
  }

  win = new BrowserWindow({
    // The caption stays 760px tall; transparent space below it also lets a
    // triggered video cover the entire monitor, including the taskbar area.
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Load the popout scoreboard from the local server
  win.loadURL('http://localhost:3000/popout.html?monitor=1');

  // Make the window click-through
  win.setIgnoreMouseEvents(true);

  // Set icon for macOS Dock explicitly
  if (process.platform === 'darwin') {
    app.dock.setIcon(iconPath);
  }

  // Ensure it stays on top of everything including fullscreen apps (macOS specific)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
