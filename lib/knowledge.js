'use strict';
// Долговременные знания AI-чата — хранятся ФАЙЛАМИ в отдельной папке, по базам.
// Структура: <root>/<ИмяБазы_hash>/
//   auto.md      — паспорт и состав базы (собирается автоматически при подключении)
//   explored.md  — изученные объекты (накапливается, когда AI запрашивает структуру)
//   learned.json — заметки ассистента (инструмент remember)
//   user.md      — знания от пользователя
// <root>/cache.json — кэш ответов справочных инструментов (по базам)
const fs = require('fs');
const path = require('path');

let root = null;
function setDir(d) { root = d; try { if (root) fs.mkdirSync(root, { recursive: true }); } catch (_) {} }
function dir() { return root; }

function hash8(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16).padStart(8, '0'); }
function sanitize(s) { return (String(s || '').replace(/[^\wА-Яа-яЁё.\- ]+/g, '_').trim().slice(0, 60)) || 'base'; }
function baseNameFromUrl(u) { try { const m = /\/([^/]+)\/hs\//i.exec(u || ''); return m ? m[1] : 'base'; } catch (_) { return 'base'; } }
function baseFolder(baseUrl) {
  if (!root) return null;
  const f = path.join(root, sanitize(baseNameFromUrl(baseUrl)) + '_' + hash8(baseUrl));
  try { fs.mkdirSync(f, { recursive: true }); } catch (_) {}
  return f;
}
function fp(baseUrl, name) { const f = baseFolder(baseUrl); return f ? path.join(f, name) : null; }
function rd(baseUrl, name) { try { const p = fp(baseUrl, name); return (p && fs.existsSync(p)) ? fs.readFileSync(p, 'utf8') : ''; } catch (_) { return ''; } }
function wr(baseUrl, name, txt) { try { fs.writeFileSync(fp(baseUrl, name), String(txt == null ? '' : txt), 'utf8'); return true; } catch (_) { return false; } }
function rj(baseUrl, name, def) { try { const p = fp(baseUrl, name); return (p && fs.existsSync(p)) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def; } catch (_) { return def; } }
function wj(baseUrl, name, obj) { try { fs.writeFileSync(fp(baseUrl, name), JSON.stringify(obj, null, 2), 'utf8'); return true; } catch (_) { return false; } }

// --- знания пользователя ---
function getUser(baseUrl) { return rd(baseUrl, 'user.md'); }
function saveUser(baseUrl, txt) { return wr(baseUrl, 'user.md', txt); }

// --- авто-собранный паспорт/состав ---
function getAuto(baseUrl) { return rd(baseUrl, 'auto.md'); }
function saveAuto(baseUrl, txt) { return wr(baseUrl, 'auto.md', txt); }
function hasAuto(baseUrl) { try { const p = fp(baseUrl, 'auto.md'); return !!(p && fs.existsSync(p) && fs.statSync(p).size > 50); } catch (_) { return false; } }

// --- изученные объекты (накопление) ---
const EXPLORED_MAX = 8000;
function getExplored(baseUrl) { return rd(baseUrl, 'explored.md'); }
function appendExplored(baseUrl, title, content) {
  let cur = getExplored(baseUrl);
  const head = '## ' + title;
  if (cur.indexOf(head) !== -1) return; // уже есть
  let block = head + '\n' + String(content || '').slice(0, 1500) + '\n\n';
  cur = block + cur; // свежее сверху
  if (cur.length > EXPLORED_MAX) cur = cur.slice(0, EXPLORED_MAX);
  wr(baseUrl, 'explored.md', cur);
}
function clearExplored(baseUrl) { return wr(baseUrl, 'explored.md', ''); }
function exploredCount(baseUrl) { const c = getExplored(baseUrl); return (c.match(/^## /gm) || []).length; }

// --- проверенные запросы (накапливаются АВТОМАТИЧЕСКИ при успешном запросе) ---
const QUERIES_MAX = 7000;
function getQueries(baseUrl) { return rd(baseUrl, 'queries.md'); }
function appendQuery(baseUrl, query, note) {
  const q = String(query || '').trim();
  if (!q || q.length < 12) return;
  let cur = getQueries(baseUrl);
  const sig = q.slice(0, 120);
  if (cur.indexOf(sig) !== -1) return; // такой запрос уже сохранён
  const head = note ? String(note).slice(0, 100) : 'Рабочий запрос';
  const block = '### ' + head + '\n```\n' + q.slice(0, 1400) + '\n```\n\n';
  cur = block + cur; // свежее сверху
  if (cur.length > QUERIES_MAX) cur = cur.slice(0, QUERIES_MAX);
  wr(baseUrl, 'queries.md', cur);
}
function queriesCount(baseUrl) { const c = getQueries(baseUrl); return (c.match(/^### /gm) || []).length; }
function clearQueries(baseUrl) { return wr(baseUrl, 'queries.md', ''); }

// --- заметки ассистента (remember) ---
function getLearned(baseUrl) { const a = rj(baseUrl, 'learned.json', []); return Array.isArray(a) ? a : []; }
function addLearned(baseUrl, title, content) {
  const a = getLearned(baseUrl);
  a.push({ title: String(title || '').slice(0, 120), content: String(content || '').slice(0, 2000), ts: Date.now() });
  wj(baseUrl, 'learned.json', a);
  return a.length;
}
function clearLearned(baseUrl) { return wj(baseUrl, 'learned.json', []); }

// --- сборка текста знаний для системного промпта ---
const AUTO_CAP = 8000, USER_CAP = 4000, LEARNED_CAP = 4000;
function cap(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '\n…(усечено)' : s; }
function buildText(baseUrl) {
  const parts = [];
  const auto = getAuto(baseUrl).trim();
  if (auto) parts.push('== ПАСПОРТ И СОСТАВ БАЗЫ (собрано автоматически) ==\n' + cap(auto, AUTO_CAP));
  const expl = getExplored(baseUrl).trim();
  if (expl) parts.push('== ИЗУЧЕННЫЕ ОБЪЕКТЫ ==\n' + cap(expl, EXPLORED_MAX));
  const learned = getLearned(baseUrl);
  if (learned.length) parts.push('== ВЫУЧЕННОЕ РАНЕЕ ==\n' + cap(learned.map((n) => `• ${n.title}\n${n.content}`).join('\n\n'), LEARNED_CAP));
  const q = getQueries(baseUrl).trim();
  if (q) parts.push('== ПРОВЕРЕННЫЕ ЗАПРОСЫ (переиспользуй и адаптируй под вопрос) ==\n' + cap(q, QUERIES_MAX));
  const u = getUser(baseUrl).trim();
  if (u) parts.push('== ЗНАНИЯ ОТ ПОЛЬЗОВАТЕЛЯ ==\n' + cap(u, USER_CAP));
  return parts.join('\n\n');
}

// --- справочные данные пользователя из выбранной папки (.md/.txt) ---
// Подмешиваются в знания как дополнительный контекст (описания счетов, регламенты, словарь терминов).
const REFDATA_CAP = 8000;
function readRefData(dirPath, capChars) {
  const cap = capChars || REFDATA_CAP;
  if (!dirPath) return '';
  let files = [];
  try { files = fs.readdirSync(dirPath); } catch (_) { return ''; }
  const picked = files
    .filter((f) => /\.(md|markdown|txt)$/i.test(f))
    .sort()
    .slice(0, 40);
  const parts = [];
  let total = 0;
  for (const f of picked) {
    if (total >= cap) break;
    let txt = '';
    try { txt = fs.readFileSync(path.join(dirPath, f), 'utf8'); } catch (_) { continue; }
    txt = String(txt || '').trim();
    if (!txt) continue;
    const room = cap - total;
    const body = txt.length > room ? txt.slice(0, room) + '\n…(усечено)' : txt;
    parts.push('## ' + f.replace(/\.(md|markdown|txt)$/i, '') + '\n' + body);
    total += body.length;
  }
  return parts.join('\n\n');
}

// --- кэш справочных инструментов (общий файл, ключ включает базу) ---
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function cachePath() { return root ? path.join(root, 'cache.json') : null; }
function readCache() { try { const p = cachePath(); return (p && fs.existsSync(p)) ? (JSON.parse(fs.readFileSync(p, 'utf8')) || {}) : {}; } catch (_) { return {}; } }
function writeCache(o) { try { fs.writeFileSync(cachePath(), JSON.stringify(o, null, 2), 'utf8'); } catch (_) {} }
function stable(o) { if (o && typeof o === 'object' && !Array.isArray(o)) return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'; return JSON.stringify(o); }
function cacheKey(base, tool, args) { return String(base || '') + '|' + tool + '|' + stable(args || {}); }
function cacheGet(base, tool, args) { const c = readCache(); const e = c[cacheKey(base, tool, args)]; if (e && (Date.now() - e.ts) < CACHE_TTL_MS) return e.result; return null; }
function cacheSet(base, tool, args, result) { const c = readCache(); c[cacheKey(base, tool, args)] = { ts: Date.now(), result }; writeCache(c); }
function clearCache() { writeCache({}); }

module.exports = {
  setDir, dir, baseFolder, baseNameFromUrl,
  getUser, saveUser, getAuto, saveAuto, hasAuto,
  getExplored, appendExplored, clearExplored, exploredCount,
  getQueries, appendQuery, queriesCount, clearQueries,
  getLearned, addLearned, clearLearned, buildText, readRefData,
  cacheGet, cacheSet, clearCache,
};
