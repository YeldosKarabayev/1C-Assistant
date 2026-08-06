'use strict';
// Хранилище истории чатов AI: сохраняем диалоги между запусками, показываем список.
const fs = require('fs');
const path = require('path');

let dir = null;
function setDir(d) { dir = d; }
function file() { return dir ? path.join(dir, 'ai-chats.json') : null; }

const MAX_CHATS = 50;

function readAll() {
  try { const f = file(); return (f && fs.existsSync(f)) ? (JSON.parse(fs.readFileSync(f, 'utf8')) || {}) : {}; }
  catch (_) { return {}; }
}
function writeAll(obj) {
  try { fs.writeFileSync(file(), JSON.stringify(obj, null, 2), 'utf8'); return true; }
  catch (_) { return false; }
}

function titleFrom(messages) {
  const first = (messages || []).find((m) => m.role === 'user' && typeof m.content === 'string');
  const t = first ? first.content.trim().replace(/\s+/g, ' ') : 'Новый диалог';
  return t.slice(0, 60) || 'Новый диалог';
}

// Список для UI: {id, title, updatedAt, count} — свежие сверху. Если задан base — только его диалоги.
function list(base) {
  const all = readAll();
  return Object.values(all)
    .filter((c) => !base || c.base === base)
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: (c.messages || []).filter((m) => m.role === 'user' && typeof m.content === 'string').length }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function get(id) { const all = readAll(); return all[id] || null; }

function save(id, messages, base) {
  const all = readAll();
  const now = Date.now();
  const prevBase = all[id] && all[id].base;
  all[id] = { id, title: titleFrom(messages), messages, updatedAt: now, base: base || prevBase || null };
  // ограничиваем число хранимых диалогов
  const ids = Object.values(all).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((c) => c.id);
  for (const extra of ids.slice(MAX_CHATS)) delete all[extra];
  writeAll(all);
  return all[id];
}

function remove(id) { const all = readAll(); delete all[id]; return writeAll(all); }
// Очистка: только диалоги указанной базы, либо все (если base не задан).
function clear(base) {
  if (!base) return writeAll({});
  const all = readAll();
  for (const k of Object.keys(all)) { if (all[k] && all[k].base === base) delete all[k]; }
  return writeAll(all);
}

module.exports = { setDir, list, get, save, remove, clear };
