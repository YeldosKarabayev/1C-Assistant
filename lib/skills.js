'use strict';
// Навыки для работы с базой 1С — файлы .md с инструкциями (язык запросов, БУХ3 и т.п.).
// Встроенные навыки едут в комплекте (папка skills/), пользователь может добавлять свои
// в отдельную папку. Включённые навыки вшиваются в системный промпт ассистента.
const fs = require('fs');
const path = require('path');

let bundledDir = null; // встроенные навыки (в комплекте приложения)
let userDir = null;    // пользовательские навыки (можно редактировать/добавлять)

function setDirs(bundled, user) {
  bundledDir = bundled || null;
  userDir = user || null;
  try { if (userDir) fs.mkdirSync(userDir, { recursive: true }); } catch (_) { /* ignore */ }
}

// Разбор frontmatter (--- name: … description: … ---) + тело.
function parseFront(txt) {
  const m = /^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(txt || '');
  const meta = {};
  let body = txt || '';
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const mm = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (mm) meta[mm[1]] = mm[2].trim();
    }
  }
  return { meta, body };
}

function readDir(dir, source) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(f)) continue;
      try {
        const p = path.join(dir, f);
        const txt = fs.readFileSync(p, 'utf8');
        const { meta, body } = parseFront(txt);
        const name = meta.name || f.replace(/\.md$/i, '');
        out.push({ name, description: meta.description || '', body: body.trim(), source, file: p });
      } catch (_) { /* пропускаем битый файл */ }
    }
  } catch (_) { /* папки нет */ }
  return out;
}

// Все навыки (пользовательский с тем же именем перекрывает встроенный).
function all() {
  const map = {};
  for (const s of (bundledDir ? readDir(bundledDir, 'bundled') : [])) map[s.name] = s;
  for (const s of (userDir ? readDir(userDir, 'user') : [])) map[s.name] = s;
  return Object.values(map);
}

// Ключ активной базы (по её URL) — навыки настраиваются отдельно для каждой базы.
function baseKey(cfg) {
  const list = (cfg && cfg.bases) || [];
  const b = list[(cfg && cfg.activeBase) || 0];
  return (b && b.url) || '';
}
// Набор выключенных навыков для активной базы (с откатом на старый глобальный список).
function disabledSet(cfg) {
  const map = (cfg && cfg.skillsDisabledByBase) || {};
  const perBase = map[baseKey(cfg)];
  if (Array.isArray(perBase)) return new Set(perBase);
  if (Array.isArray(cfg && cfg.skillsDisabled)) return new Set(cfg.skillsDisabled); // миграция
  return new Set();
}

// Список для UI: {name, description, source, enabled} — для АКТИВНОЙ базы.
function list(cfg) {
  const disabled = disabledSet(cfg);
  return all().map((s) => ({ name: s.name, description: s.description, source: s.source, enabled: !disabled.has(s.name) }));
}

const CAP = 40000; // суммарный лимит текста включённых навыков (в API-режиме системный блок кэшируется)
// Текст включённых навыков активной базы для системного промпта.
function buildText(cfg) {
  const disabled = disabledSet(cfg);
  const on = all().filter((s) => !disabled.has(s.name) && s.body);
  if (!on.length) return '';
  let t = on.map((s) => `## НАВЫК: ${s.name}\n${s.body}`).join('\n\n');
  if (t.length > CAP) t = t.slice(0, CAP) + '\n…(навыки усечены)';
  return '== НАВЫКИ РАБОТЫ С БАЗОЙ 1С ==\nОпирайся на эти навыки при построении запросов к базе.\n\n' + t;
}

function dir() { return userDir; }

module.exports = { setDirs, list, buildText, dir, all, baseKey };
