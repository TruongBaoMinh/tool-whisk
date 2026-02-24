/**
 * AI Studio — Electron Main Process
 * Manages window lifecycle and spawns Python backend.
 */

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let backendProcess = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 1024,
        minHeight: 700,
        backgroundColor: '#1a1410',
        title: 'AI Studio',
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function getDataDir() {
    // In packaged mode, store data in %APPDATA%/ai-studio
    // In dev mode, use backend/data as before
    if (app.isPackaged) {
        const dataDir = path.join(app.getPath('userData'), 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        return dataDir;
    }
    return path.join(__dirname, 'backend', 'data');
}

function startBackend() {
    const dataDir = getDataDir();
    const dbPath = path.join(dataDir, 'ai_studio.db');
    const outputDir = path.join(dataDir, 'output');

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Environment variables for the backend
    const env = {
        ...process.env,
        AI_STUDIO_DB_PATH: dbPath,
        AI_STUDIO_OUTPUT_DIR: outputDir,
    };

    if (app.isPackaged) {
        // ── Packaged mode: spawn backend.exe ──
        const backendExe = path.join(process.resourcesPath, 'backend', 'backend.exe');
        console.log(`[Backend] Starting packaged backend: ${backendExe}`);

        backendProcess = spawn(backendExe, [], {
            stdio: 'pipe',
            env: env,
        });
    } else {
        // ── Dev mode: spawn python -m uvicorn ──
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const backendDir = path.join(__dirname, 'backend');

        backendProcess = spawn(pythonCmd, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8001', '--log-level', 'debug'], {
            cwd: backendDir,
            stdio: 'pipe',
            shell: true,
            env: env,
        });
    }

    backendProcess.stdout.on('data', (data) => {
        console.log(`[Backend] ${data}`);
    });

    backendProcess.stderr.on('data', (data) => {
        console.error(`[Backend] ${data}`);
    });

    backendProcess.on('error', (err) => {
        console.error('[Backend] Failed to start:', err);
    });

    backendProcess.on('exit', (code) => {
        console.log(`[Backend] Exited with code ${code}`);
        backendProcess = null;
    });
}

function stopBackend() {
    if (backendProcess) {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
        } else {
            backendProcess.kill('SIGTERM');
        }
        backendProcess = null;
    }
}

app.whenReady().then(() => {
    startBackend();
    // Give the backend a moment to initialize
    setTimeout(createWindow, 1500);
});

app.on('window-all-closed', () => {
    stopBackend();
    app.quit();
});

app.on('before-quit', () => {
    stopBackend();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
