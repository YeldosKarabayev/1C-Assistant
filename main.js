'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const settings = require('./lib/settings');
const ai = require('./lib/ai');
const knowledge = require('./lib/knowledge');
const chatstore = require('./lib/chatstore');
const skills = require('./lib/skills');

const BUNDLED_SKILLS = path.join(__dirname, 'skills'); // встроенные навыки (в комплекте)

let win = null;

function send(channel, payload) { try { if (win && win.webContents) win.webContents.send(channel, payload); } catch (_) { /* ignore */ } }

// Тихое авто-обновление через GitHub Releases (как в DevOps Studio).
let autoInstallRequested = false;
function setupUpdater() {
  autoUpdater.autoDownload = false;          // качаем только по кнопке
  autoUpdater.autoInstallOnAppQuit = true;   // если скачали — поставится при закрытии
  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (i) => send('update:status', { state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => send('update:status', { state: 'none', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => {
    send('update:status', { state: 'downloaded', version: i.version });
    if (autoInstallRequested) setImmediate(() => autoUpdater.quitAndInstall(true, true)); // тихо + автоперезапуск
  });
  autoUpdater.on('error', (e) => { autoInstallRequested = false; send('update:status', { state: 'error', message: String(e && e.message || e) }); });
  if (app.isPackaged) { autoUpdater.checkForUpdates().catch(() => {}); } // на старте только проверяем
}

function initStorage() {
  const userData = app.getPath('userData');
  settings.setPath(path.join(userData, 'settings.json'));
  const cfg = settings.load();
  knowledge.setDir(cfg.knowledgeDir || path.join(userData, 'knowledge'));
  chatstore.setDir(userData);
  skills.setDirs(BUNDLED_SKILLS, cfg.skillsDir || path.join(userData, 'skills'));
  return cfg;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    frame: false,
    backgroundColor: '#faf9f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(() => {
  initStorage();
  createWindow();
  setupUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- окно ---
ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:maximize', () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
ipcMain.handle('win:close', () => { if (win) win.close(); });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:openExternal', (_e, url) => { try { shell.openExternal(url); } catch (_) {} });

// --- обновления ---
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { dev: true };
  try { const r = await autoUpdater.checkForUpdates(); return { ok: true, version: r && r.updateInfo && r.updateInfo.version }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});
// Проверить → скачать → молча установить и перезапустить.
ipcMain.handle('update:downloadAndInstall', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Обновления работают только в установленной версии (не в режиме разработки).' };
  autoInstallRequested = true;
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    if (!v || v === app.getVersion()) { autoInstallRequested = false; return { ok: false, error: 'Установлена последняя версия.' }; }
    autoUpdater.downloadUpdate().catch((err) => send('update:status', { state: 'error', message: String(err && err.message || err) }));
    return { ok: true, version: v };
  } catch (e) { autoInstallRequested = false; return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('update:install', () => { setImmediate(() => autoUpdater.quitAndInstall(true, true)); });
// Последний релиз с GitHub — для отображения версии и статуса (как в DevOps Studio).
ipcMain.handle('update:latest', async () => {
  try {
    const res = await fetch('https://api.github.com/repos/YeldosKarabayev/1C-Assistant/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': '1C-Assistant' },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, current: app.getVersion(), error: res.status === 404 ? 'Релиз не найден' : `HTTP ${res.status}` };
    }
    const j = await res.json();
    const version = String(j.tag_name || '').replace(/^v/i, '');
    return { ok: true, version, name: j.name, url: j.html_url, current: app.getVersion() };
  } catch (e) {
    return { ok: false, current: app.getVersion(), error: String((e && e.message) || e) };
  }
});
ipcMain.handle('app:openPath', async (_e, p) => { try { return await shell.openPath(p); } catch (e) { return String(e && e.message || e); } });
ipcMain.handle('app:showInFolder', (_e, p) => { try { shell.showItemInFolder(p); } catch (_) {} });
ipcMain.handle('app:chooseFolder', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return (r && !r.canceled && r.filePaths && r.filePaths[0]) ? r.filePaths[0] : null;
  } catch (_) { return null; }
});

// --- настройки ---
ipcMain.handle('settings:get', () => settings.load());
ipcMain.handle('settings:save', (_e, data) => {
  const ok = settings.save(data);
  const cfg = settings.load();
  knowledge.setDir(cfg.knowledgeDir);
  skills.setDirs(BUNDLED_SKILLS, cfg.skillsDir);
  ai.invalidate(); // сброс кэша инструментов/соединения при смене базы
  return { ok, settings: cfg };
});

// --- AI / база ---
ipcMain.handle('ai:testBase', async (_e, params) => {
  try { const r = await ai.testBase(params); return { ok: true, tools: r.tools }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('ai:ping', async () => {
  try { const r = await ai.pingRsv(settings.load()); return { ok: true, tools: r.tools }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('ai:authStatus', () => ai.authStatus(settings.load()));
ipcMain.handle('ai:ccStatus', () => ai.ccStatus());
ipcMain.handle('ai:testAuth', async () => ai.testAuth(settings.load()));
ipcMain.handle('ai:testModels', async () => ai.testModels(settings.load()));
ipcMain.handle('ai:warm', async () => ai.warm(settings.load()));
ipcMain.handle('ai:reset', () => { ai.resetConversation(); return true; });
ipcMain.handle('ai:collectBase', async () => ai.collectBase(settings.load()));
ipcMain.handle('ai:clearKnowledge', () => ai.clearKnowledge(settings.load()));
ipcMain.handle('ai:knowledgeGet', () => ai.getKnowledge(settings.load()));
ipcMain.handle('ai:knowledgeSaveUser', (_e, text) => ai.saveUserKnowledge(settings.load(), text));

// --- навыки ---
ipcMain.handle('skills:list', () => skills.list(settings.load()));
ipcMain.handle('skills:setEnabled', (_e, { name, enabled }) => {
  const cfg = settings.load();
  const key = skills.baseKey(cfg); // навыки — свои для каждой базы
  const map = cfg.skillsDisabledByBase || {};
  const cur = Array.isArray(map[key]) ? map[key] : (Array.isArray(cfg.skillsDisabled) ? cfg.skillsDisabled : []);
  const dis = new Set(cur);
  if (enabled) dis.delete(name); else dis.add(name);
  map[key] = [...dis];
  cfg.skillsDisabledByBase = map;
  settings.save(cfg);
  ai.invalidate();
  return { ok: true, skills: skills.list(cfg) };
});
ipcMain.handle('skills:openDir', () => { try { const d = settings.load().skillsDir; shell.openPath(d); return d; } catch (_) { return null; } });
ipcMain.handle('export:table', async (_e, input) => {
  try { const out = await ai.exportTable(settings.load(), input); return { ok: true, path: out.file, name: out.name, rows: out.rows }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('ai:send', async (e, text) => {
  const cfg = settings.load();
  const emit = (evt) => { try { e.sender.send('ai:event', evt); } catch (_) {} };
  await ai.send(cfg, text, emit);
  return true;
});

// история
ipcMain.handle('ai:chats', () => ai.listChats(settings.load()));
ipcMain.handle('ai:currentId', () => ai.currentChatId());
ipcMain.handle('ai:chatLoad', (_e, id) => ai.loadChat(id));
ipcMain.handle('ai:chatDelete', (_e, id) => ai.deleteChat(id));
ipcMain.handle('ai:chatsClear', () => ai.clearChats(settings.load()));
