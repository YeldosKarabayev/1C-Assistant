'use strict';
// Настройки «1С Ассистента» — простые, под обычного пользователя.
// Хранятся в userData/settings.json. В приложение попадают: список баз пользователя,
// какая база активна, и (по желанию/для админа) доступ к AI.
const fs = require('fs');
const path = require('path');
const os = require('os');

let settingsPath = null;
function setPath(p) { settingsPath = p; }

// Basic-заголовок из логина/пароля.
function basicAuth(user, pass) {
  if (!user && !pass) return '';
  return 'Basic ' + Buffer.from(`${user || ''}:${pass || ''}`, 'utf8').toString('base64');
}

function baseNameFromUrl(u) {
  try { const m = /\/([^/]+)\/hs\//i.exec(u || ''); return m ? m[1] : 'База'; } catch (_) { return 'База'; }
}

// Одна база: нормализуем — всегда есть готовый auth-заголовок.
function normBase(b) {
  const o = {
    name: (b && b.name) || '',
    url: (b && b.url) || '',
    user: (b && b.user) || '',
    pass: (b && b.pass) || '',
    auth: (b && b.auth) || '',
  };
  if (!o.name) o.name = baseNameFromUrl(o.url);
  // если заданы логин/пароль — auth всегда пересобираем из них (пароль мог смениться)
  if (o.user || o.pass) o.auth = basicAuth(o.user, o.pass);
  return o;
}

function defaults() {
  const home = os.homedir();
  const bases = [];

  // Автоподхват первой базы из рабочего .mcp.json (для разработки/проверки).
  try {
    const buh = path.join(home, 'Desktop', 'Yeldos Desktop', 'Новая папка', 'BUH Cursor');
    const mcpCfg = path.join(buh, '.mcp.json');
    if (fs.existsSync(mcpCfg)) {
      const j = JSON.parse(fs.readFileSync(mcpCfg, 'utf8'));
      const rsv = j.mcpServers && j.mcpServers['rsv-data'];
      if (rsv && rsv.url) {
        bases.push(normBase({
          name: baseNameFromUrl(rsv.url),
          url: rsv.url,
          auth: (rsv.headers && rsv.headers.Authorization) || '',
        }));
      }
    }
  } catch (_) { /* ignore */ }

  return {
    onboarded: bases.length > 0, // если база уже подхватилась — мастер не нужен
    bases,
    activeBase: 0,
    // Доступ к AI (обычно настраивает админ один раз)
    aiApiKey: '',
    aiUseAccount: true, // брать вход Claude с этого ПК, если ключ не задан
    aiFast: true,       // быстрый режим (меньше задержек)
    aiOnLimit: 'fallback', // при лимите сильной модели сразу отвечаем доступной (без ожидания): wait | fallback | error
    aiModel: 'claude-sonnet-5',
    aiEngine: 'api', // движок ответа: 'api' (SDK напрямую) | 'claude-code' (запуск CLI Claude Code — надёжные сильные модели с подписки)
    knowledgeDir: path.join(home, 'Documents', '1C-Assistant', 'knowledge'),
    dataDir: '', // папка со справочными данными пользователя (.md/.txt) — подмешиваются в знания (пусто = не задано)
    // Внешний вид и файлы
    exportDir: path.join(home, 'Downloads'), // куда сохраняются Excel/CSV
    theme: 'system',    // light | dark | system
    fontSize: 'normal', // normal | large
    savedReports: [],   // [{name, question}] — сохранённые вопросы-отчёты
    // Навыки работы с базой 1С
    skillsDir: path.join(home, 'Documents', '1C-Assistant', 'skills'), // пользовательские навыки
    skillsDisabled: [], // (устаревшее, для миграции) глобально выключенные навыки
    skillsDisabledByBase: {}, // { <url базы>: [выключенные навыки] } — набор навыков на каждую базу
  };
}

function load() {
  try {
    if (settingsPath && fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const def = defaults();
      const merged = { ...def, ...saved };
      merged.bases = (Array.isArray(merged.bases) ? merged.bases : []).map(normBase).filter((b) => b.url);
      if (!merged.bases.length && def.bases.length) merged.bases = def.bases;
      if (typeof merged.activeBase !== 'number' || merged.activeBase < 0 || merged.activeBase >= merged.bases.length) {
        merged.activeBase = 0;
      }
      return merged;
    }
  } catch (_) { /* corrupt -> defaults */ }
  return defaults();
}

function save(data) {
  try {
    const d = { ...data };
    d.bases = (Array.isArray(d.bases) ? d.bases : []).map(normBase).filter((b) => b.url);
    if (typeof d.activeBase !== 'number' || d.activeBase < 0 || d.activeBase >= d.bases.length) d.activeBase = 0;
    fs.writeFileSync(settingsPath, JSON.stringify(d, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { setPath, load, save, defaults, normBase, basicAuth, baseNameFromUrl };
