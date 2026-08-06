'use strict';
// AI-чат: агентный цикл Anthropic Messages API + инструменты RSV Data (через lib/rsvmcp).
// Пользователь пишет вопрос обычным языком, Claude сам решает, когда обратиться к базе
// через инструменты RSV Data; вызовы исполняем локально (main-процесс) и возвращаем модели.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');
const { RsvMcp, toolResultText } = require('./rsvmcp');
const { resolveCredential, credStatus } = require('./creds');
const knowledge = require('./knowledge');
const chatstore = require('./chatstore');
const skills = require('./skills');
const claudecode = require('./claudecode');

// Инструмент долговременной памяти (исполняется локально, не через RSV Data).
const REMEMBER_TOOL = {
  name: 'remember',
  description: 'Сохранить в долговременную память полезное знание о базе, чтобы в будущем не изучать его заново: структуру таблицы/регистра, значение счёта/субконто, рабочий шаблон запроса. Пиши кратко и конкретно.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Короткий заголовок темы' },
      content: { type: 'string', description: 'Само знание: факты, схема, пример запроса' },
    },
    required: ['title', 'content'],
  },
};
// Инструмент выгрузки в Excel (исполняется локально: пишем .xlsx в папку Загрузки).
const EXPORT_TOOL = {
  name: 'export_to_excel',
  description: 'Сохранить табличные данные в файл Excel (.xlsx) на компьютере пользователя (папка «Загрузки») и показать кнопку для открытия. Вызывай, когда пользователь просит выгрузить/скачать/экспортировать данные в Excel или таблицу. Сначала получи реальные данные из базы, затем передай сюда понятные заголовки колонок и строки со значениями (в том же порядке).',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Имя файла без расширения, например «Продажи за май 2026»' },
      sheet: { type: 'string', description: 'Название листа (необязательно)' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Заголовки колонок по порядку' },
      rows: { type: 'array', description: 'Строки таблицы: массив строк, каждая строка — массив значений в порядке колонок', items: { type: 'array', items: {} } },
    },
    required: ['columns', 'rows'],
  },
};

// Универсальное сохранение текстового файла (CSV / TXT / Markdown).
const SAVE_FILE_TOOL = {
  name: 'save_file',
  description: 'Сохранить текстовый файл (CSV, TXT или Markdown) на компьютере пользователя (папка «Загрузки») и показать кнопку открытия. Используй для выгрузки в CSV или для сохранения текстового отчёта/справки. Для настоящих таблиц Excel используй export_to_excel.',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Имя файла без расширения' },
      format: { type: 'string', enum: ['csv', 'txt', 'md'], description: 'Формат файла (по умолчанию txt)' },
      content: { type: 'string', description: 'Полное содержимое файла' },
    },
    required: ['content'],
  },
};

// Показать данные графиком прямо в чате (рендерит UI, данные — из ответа модели).
const CHART_TOOL = {
  name: 'create_chart',
  description: 'Показать данные в виде графика прямо в чате. Вызывай, когда пользователь просит график/диаграмму/визуализацию, или когда так нагляднее (динамика, сравнение, доли). Сначала получи реальные данные из базы.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'Тип: bar (столбики) / line (линия) / pie (круговая)' },
      title: { type: 'string', description: 'Заголовок графика' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Подписи оси X (для pie — названия секторов)' },
      series: {
        type: 'array', description: 'Ряды данных (для pie — один ряд)',
        items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['values'] },
      },
    },
    required: ['type', 'labels', 'series'],
  },
};
// Предложить короткие вопросы-продолжения (кнопки под ответом).
const FOLLOWUP_TOOL = {
  name: 'suggest_followups',
  description: 'Предложить пользователю 2–4 коротких вопроса-продолжения по текущей теме (кнопки под ответом). Вызывай ОДИН раз в самом конце ответа, если это уместно.',
  input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, description: 'Короткие вопросы, до ~45 символов' } }, required: ['items'] },
};

// Число из строки для Excel («150 000» / «1 234,50» → number), иначе как есть.
function numify(v) {
  if (typeof v !== 'string') return v;
  const t = v.replace(/\s| /g, '').replace(',', '.');
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return v;
}

function sanitizeFile(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Выгрузка'; }

// Уникальный путь в папке экспорта (Загрузки), без перезаписи существующих файлов.
function uniquePath(cfg, baseName, ext) {
  const dir = (cfg && cfg.exportDir) || path.join(os.homedir(), 'Downloads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  const bn = sanitizeFile(baseName);
  let file = path.join(dir, bn + '.' + ext);
  for (let i = 2; fs.existsSync(file); i += 1) file = path.join(dir, bn + ' (' + i + ').' + ext);
  return file;
}

// Пишем .xlsx: жирная шапка, автоширина колонок, автофильтр, закреплённая первая строка.
async function writeExcel(cfg, input) {
  const dir = (cfg && cfg.exportDir) || path.join(os.homedir(), 'Downloads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  const baseName = sanitizeFile(input.filename || 'Выгрузка');
  let file = path.join(dir, baseName + '.xlsx');
  for (let i = 2; fs.existsSync(file); i += 1) file = path.join(dir, baseName + ' (' + i + ').xlsx');

  const cols = Array.isArray(input.columns) ? input.columns.map((c) => String(c)) : [];
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sanitizeFile(input.sheet || 'Данные').slice(0, 31));
  if (cols.length) {
    const head = ws.addRow(cols);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2FF' } };
  }
  for (const r of rows) ws.addRow((Array.isArray(r) ? r : [r]).map(numify));
  ws.columns.forEach((c) => {
    let max = 10;
    c.eachCell({ includeEmpty: false }, (cell) => { const l = String(cell.value == null ? '' : cell.value).length; if (l > max) max = l; });
    c.width = Math.min(max + 2, 60);
  });
  if (cols.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  await wb.xlsx.writeFile(file);
  return { file, rows: rows.length, name: path.basename(file) };
}

// Справочные инструменты RSV Data — их результаты кэшируем (структура почти не меняется).
const READONLY_TOOLS = new Set(['get_structure', 'describe', 'help', 'config']);

// Клиент Anthropic из учётных данных: явный ключ либо OAuth-токен аккаунта Claude.
function buildClient(cred, maxRetries) {
  const mr = maxRetries == null ? 4 : maxRetries;
  if (cred.mode === 'oauth') {
    return new Anthropic({ authToken: cred.token, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' }, maxRetries: mr });
  }
  return new Anthropic({ apiKey: cred.apiKey, maxRetries: mr });
}

// Понятное сообщение об ошибке API вместо сырого JSON — простым языком для сотрудника.
function formatApiError(e) {
  const status = e && (e.status || e.statusCode);
  let retryAfter = '';
  try {
    const h = e && e.headers;
    const ra = h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after']);
    if (ra) retryAfter = ` Попробуйте снова примерно через ${ra} с.`;
  } catch (_) { /* ignore */ }

  if (status === 429) {
    return 'Сейчас много обращений к AI — сервис попросил немного подождать.' + retryAfter +
      ' Обычно достаточно повторить вопрос через минуту.';
  }
  if (status === 401 || status === 403) {
    return `Нет доступа к AI (${status}). Обратитесь к администратору — возможно, истёк доступ к Claude.`;
  }
  if (status === 400) {
    return `AI не понял запрос (400): ${(e && e.message) || ''}.`;
  }
  if (status === 529) return 'Сервис AI временно перегружен. Попробуйте чуть позже.';
  return String((e && e.message) || e);
}

function noCredMessage(cred) {
  if (cred.reason === 'account-expired') {
    return 'Доступ к AI на этом компьютере истёк. Обратитесь к администратору для повторной настройки.';
  }
  return 'AI ещё не настроен на этом компьютере. Откройте Настройки → «Доступ к AI» или обратитесь к администратору.';
}

const SYSTEM = [
  'Ты — дружелюбный ассистент по базе 1С. Пользователь — обычный сотрудник компании, НЕ программист.',
  'Отвечай на русском, простым и понятным языком, без технического жаргона и без названий внутренних таблиц/регистров, если это не нужно пользователю.',
  'Данные из базы получай ТОЛЬКО через доступные инструменты — никогда не выдумывай цифры и факты.',
  'Ты УМЕЕШЬ создавать файлы. Для таблиц Excel — инструмент export_to_excel (заголовки колонок + строки). Для CSV или текстовых отчётов/справок — инструмент save_file (формат csv/txt/md). Когда пользователь просит скачать/выгрузить/экспортировать/сохранить — сначала получи данные из базы, затем вызови нужный инструмент и коротко подтверди, что файл готов (кнопка «Открыть файл» появится у пользователя).',
  'Будь инициативным и полезным: НИКОГДА не отвечай «я не могу этого сделать» преждевременно. Сначала разберись, можно ли решить задачу доступными инструментами (данные из базы + создание файлов), и сделай максимум. Если чего-то действительно нельзя сделать — объясни простыми словами почему и предложи ближайшую альтернативу.',
  'Изменять данные в базе (создавать/проводить/удалять документы) ты НЕ можешь — доступ только на чтение. Если просят это — честно скажи и подскажи, как сделать в самой 1С.',
  'Числа показывай аккуратно: суммы с разделением разрядов и указанием валюты, даты в привычном виде. Списки и сравнения оформляй таблицей или маркированным списком — так нагляднее.',
  'Если данные нагляднее показать графиком (динамика по времени, сравнение категорий, доли целого) — вызови create_chart (bar/line/pie). Для долей — pie, для динамики — line, для сравнения — bar.',
  'В самом конце ответа, когда это уместно, предложи 2–4 коротких вопроса-продолжения через suggest_followups (например «разбить по месяцам», «только по складу X»).',
  'Если вопрос неоднозначный (не указан период, склад, организация) — коротко переспроси, что именно нужно, вместо того чтобы гадать.',
  'Если инструмент вернул ошибку — не показывай сырую техническую ошибку, а объясни простыми словами, что пошло не так, и предложи, как уточнить запрос.',
  'У тебя есть память о базе (ниже раздел ЗНАНИЯ, если он есть). Опирайся на неё и НЕ изучай повторно то, что там уже описано.',
  'Прежде чем строить запрос, при необходимости уточни структуру справочными инструментами — но только если этого нет в знаниях.',
  'НАКОПЛЕНИЕ ЗНАНИЙ (важно): пользователь НЕ пишет знания вручную — ты накапливаешь их сам. Как только узнал полезное о базе (значение счёта/субконто, структуру объекта/регистра, где лежат нужные данные, какой организации/номенклатуре что соответствует) — СРАЗУ сохрани это инструментом remember: короткий факт + как использовать. Рабочие запросы сохраняются автоматически. Всегда сперва опирайся на накопленные знания (разделы ЗНАНИЯ ниже) и не изучай/не переспрашивай повторно то, что там уже есть.',
].join(' ');

// Системный промпт для режима «Через Claude Code»: там наших локальных инструментов
// (export_to_excel/create_chart/…) нет — есть только доступ к базе через RSV Data (mcp__rsv-data__*).
const SYSTEM_CC = [
  'Ты — дружелюбный ассистент по базе 1С. Пользователь — обычный сотрудник компании, НЕ программист.',
  'Отвечай на русском, простым и понятным языком, без технического жаргона и без названий внутренних таблиц/регистров, если это не нужно пользователю.',
  'Данные из базы получай ТОЛЬКО через инструменты доступа к базе (mcp__rsv-data__*) — никогда не выдумывай цифры и факты. Доступ только на чтение.',
  'Изменять данные в базе (создавать/проводить/удалять документы) ты НЕ можешь. Если просят это — честно скажи и подскажи, как сделать в самой 1С.',
  'Числа показывай аккуратно: суммы с разделением разрядов и валютой, даты в привычном виде. Табличные данные ВСЕГДА оформляй markdown-таблицей — под таблицей у пользователя появится кнопка «Скачать в Excel».',
  'Если пользователь просит выгрузить/скачать/экспортировать данные — покажи данные markdown-таблицей и подскажи, что таблицу можно скачать кнопкой под ней (файлы ты сам не создаёшь).',
  'Если вопрос неоднозначный (не указан период, склад, организация) — коротко переспроси, что именно нужно, вместо того чтобы гадать.',
  'Если инструмент вернул ошибку — не показывай сырую техническую ошибку, а объясни простыми словами, что пошло не так, и предложи, как уточнить запрос.',
  'У тебя есть память о базе (ниже раздел ЗНАНИЯ, если он есть). Опирайся на неё и НЕ изучай повторно то, что там уже описано.',
  'НАКОПЛЕНИЕ ЗНАНИЙ: если по ходу ответа ты узнал устойчивый факт о базе (значение счёта/субконто, где лежат нужные данные, соответствие организации/номенклатуры, важную особенность структуры) — в САМОМ КОНЦЕ ответа, ПОСЛЕ всего обычного текста, добавь с новой строки одну или несколько строк строго в формате: §ЗНАНИЕ§ Короткий заголовок :: краткое содержание факта. Эти строки — служебные (пользователю не показываются), пиши их последними и ничего после них не добавляй.',
].join(' ');

const DEFAULT_MODEL = 'claude-sonnet-5';

// Цепочка деградации по качеству при лимите (429).
function modelChain(model) {
  if (model === 'claude-opus-5') return ['claude-sonnet-5', 'claude-haiku-4-5'];
  if (model === 'claude-sonnet-5') return ['claude-haiku-4-5'];
  return [];
}
const WAIT_BUDGET_MS = 120000; // сколько всего ждём освобождения лимита (режим «подождать»)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfterMs(e) {
  try {
    const h = e && e.headers;
    const ra = h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after']);
    const n = parseInt(ra, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 60000) : 0;
  } catch (_) { return 0; }
}

const MAX_TOKENS = 8000;
const MAX_TOOL_ROUNDS = 20; // предохранитель от бесконечного цикла инструментов (запас на сложные многошаговые вопросы)

// Ограничения контекста: результаты инструментов (особенно query/describe) могут быть
// огромными и раздувать историю. Обрезаем каждый результат и держим историю в бюджете,
// иначе на лёгкой модели (окно 200К токенов) получим 400 «prompt is too long».
const TOOL_RESULT_CAP = 12000;         // максимум символов одного результата в истории
const HISTORY_TOKEN_BUDGET = 120000;   // грубый бюджет истории (с запасом под окно 200К)
function capResult(s) {
  s = String(s == null ? '' : s);
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + `\n…(результат усечён; показаны первые ${TOOL_RESULT_CAP} символов — при необходимости уточни запрос, чтобы данных было меньше)` : s;
}
function estTokens(content) {
  let n = 0;
  if (typeof content === 'string') n = content.length;
  else if (Array.isArray(content)) for (const b of content) n += JSON.stringify(b || '').length;
  else n = JSON.stringify(content || '').length;
  return Math.ceil(n / 2); // грубая оценка (кириллица токенизируется дороже латиницы)
}
function historyTokens() { return history.reduce((t, m) => t + estTokens(m.content), 0); }
// Сжатие истории: убираем самые старые ходы, сохраняя валидность (не начинаем с assistant
// и не оставляем user с tool_result без предшествующего tool_use).
function truncateBig() {
  for (const m of history) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > TOOL_RESULT_CAP) b.content = capResult(b.content);
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.length > TOOL_RESULT_CAP * 2) b.text = b.text.slice(0, TOOL_RESULT_CAP * 2) + '\n…(усечено)';
    }
  }
}
function compactHistory(budget) {
  truncateBig(); // сначала ужимаем уже накопленные крупные результаты (лечит старую историю)
  while (history.length > 2 && historyTokens() > budget) {
    history.shift();
    while (history.length && (
      history[0].role === 'assistant' ||
      (history[0].role === 'user' && Array.isArray(history[0].content) && history[0].content.some((b) => b && b.type === 'tool_result'))
    )) history.shift();
  }
}

// effort поддерживают Sonnet 5 / Opus 5; Haiku 4.5 — нет (вернёт 400), ему не шлём.
function supportsEffort(model) {
  return model === 'claude-sonnet-5' || model === 'claude-opus-5';
}

// Текущая беседа (одно окно чата). Сохраняется в историю между запусками.
let history = [];        // сообщения в формате Anthropic
let currentId = null;    // id текущего диалога в истории (null → ещё не сохранён)
let currentBase = null;  // база (url), к которой относится текущий диалог — история раздельна по базам
let ccSessionId = null;  // id сессии Claude Code для продолжения диалога (--resume) в режиме «Через Claude Code»
let toolsCache = null;   // список инструментов RSV Data (Anthropic-формат)
let mcp = null;          // экземпляр RsvMcp

function genId() { return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6); }
function resetConversation() { history = []; currentId = null; currentBase = null; ccSessionId = null; }

// Починка истории: каждый assistant-блок tool_use ДОЛЖЕН иметь парный tool_result
// в следующем сообщении, иначе Anthropic отдаёт 400. Если ход был прерван —
// дописываем недостающие tool_result (is_error), чтобы диалог снова стал валидным.
function repairHistory() {
  for (let i = 0; i < history.length; i += 1) {
    const m = history[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b && b.type === 'tool_use').map((b) => b.id);
    if (!ids.length) continue;
    const next = history[i + 1];
    const have = (next && next.role === 'user' && Array.isArray(next.content))
      ? new Set(next.content.filter((b) => b && b.type === 'tool_result').map((b) => b.tool_use_id))
      : new Set();
    const missing = ids.filter((id) => !have.has(id));
    if (!missing.length) continue;
    const blocks = missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '(предыдущий запрос был прерван)', is_error: true }));
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      next.content = blocks.concat(next.content); // tool_result обязаны идти первыми
    } else {
      history.splice(i + 1, 0, { role: 'user', content: blocks });
    }
  }
}

// Добавить новое сообщение пользователя, не создавая двух user-сообщений подряд
// (после починки последним может оказаться user с tool_result).
function pushUser(text) {
  repairHistory();
  const last = history[history.length - 1];
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    if (!Array.isArray(last.content)) last.content = [];
    last.content.push({ type: 'text', text });
  } else {
    history.push({ role: 'user', content: text });
  }
}

function persist() {
  if (!history.length) return;
  if (!currentId) currentId = genId();
  try { chatstore.save(currentId, history, currentBase); } catch (_) { /* ignore */ }
}

function currentChatId() { return currentId; }
// История раздельна по базам: список и очистка — только для активной базы.
function listChats(cfg) { try { return chatstore.list(activeBase(cfg).url); } catch (_) { return []; } }
function deleteChat(id) { if (id === currentId) resetConversation(); try { return chatstore.remove(id); } catch (_) { return false; } }
function clearChats(cfg) { resetConversation(); try { return chatstore.clear(activeBase(cfg).url); } catch (_) { return false; } }

// Восстановить события диалога для отрисовки из сообщений Anthropic.
function toTranscript(msgs) {
  const out = [];
  const names = {}; // tool_use_id -> имя инструмента
  for (const m of msgs || []) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ type: 'user', text: m.content });
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_result') {
            const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            out.push({ type: 'tool_result', name: names[b.tool_use_id] || 'tool', ok: !b.is_error, preview: String(c || '').slice(0, 400) });
          } else if (b && b.type === 'text') { out.push({ type: 'user', text: b.text }); }
        }
      }
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      let txt = '';
      for (const b of m.content) {
        if (b && b.type === 'text') txt += b.text;
        else if (b && b.type === 'tool_use') {
          names[b.id] = b.name;
          if (txt) { out.push({ type: 'assistant', text: txt }); txt = ''; }
          out.push({ type: 'tool_use', name: b.name, input: b.input });
        }
      }
      if (txt) out.push({ type: 'assistant', text: txt });
    }
  }
  return out;
}

function loadChat(id) {
  const c = chatstore.get(id);
  if (!c) return null;
  history = Array.isArray(c.messages) ? c.messages : [];
  currentId = id;
  currentBase = c.base || null;
  ccSessionId = null; // сессию Claude Code для сохранённого диалога не восстановить — начнём новую
  return { id, title: c.title, transcript: toTranscript(history) };
}

// Активная база из настроек (список bases + индекс activeBase).
function activeBase(cfg) {
  const list = (cfg && cfg.bases) || [];
  const b = list[(cfg && cfg.activeBase) || 0];
  if (b && b.url) return { name: b.name || '', url: b.url, auth: b.auth || '' };
  return { name: '', url: '', auth: '' };
}

function makeMcp(cfg) {
  const a = activeBase(cfg);
  return new RsvMcp({ url: a.url, auth: a.auth });
}

async function getTools(cfg) {
  if (toolsCache) return toolsCache;
  if (!mcp) mcp = makeMcp(cfg);
  const list = await mcp.listTools();
  toolsCache = list.map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
  }));
  return toolsCache;
}

// Сбросить кэши при смене настроек базы.
function invalidate() { toolsCache = null; mcp = null; }

async function pingRsv(cfg) {
  const probe = makeMcp(cfg);
  return probe.ping();
}

// Живая проверка соединения по произвольным параметрам (для формы подключения),
// не трогая настройки/кэш.
async function testBase(params) {
  const probe = new RsvMcp({ url: (params && params.url) || '', auth: (params && params.auth) || '' });
  return probe.ping();
}

// emit(evt) — колбэк событий в UI.
async function send(cfg, userText, emit) {
  // Режим «Через Claude Code» — отдельный путь (CLI сам авторизуется подпиской/ключом).
  if (cfg.aiEngine === 'claude-code') { return sendViaClaudeCode(cfg, userText, emit); }

  const cred = resolveCredential(cfg);
  if (cred.mode === 'none') {
    emit({ type: 'error', message: noCredMessage(cred) });
    return;
  }
  const a = activeBase(cfg);
  const base = a.url;
  if (!base) {
    emit({ type: 'error', message: 'Не подключена база. Откройте «Подключить базу» и введите данные доступа.' });
    return;
  }
  // новый диалог начинается на текущей базе; если продолжаем чужой (после смены базы) — переносим на активную
  if (!currentBase) currentBase = base;

  const onLimit = cfg.aiOnLimit || 'fallback'; // wait | fallback | error
  // fallback — мгновенное переключение на доступную модель: 0 ретраев SDK (иначе он сам ждёт перед 429)
  const client = buildClient(cred, onLimit === 'wait' ? 1 : (onLimit === 'fallback' ? 0 : 3));
  let model = cfg.aiModel || DEFAULT_MODEL;
  const chain = modelChain(model);
  let waited = 0, waitStep = 0;
  const effort = cfg.aiFast === false ? 'high' : 'low';
  let effortOk = true;

  let tools;
  try {
    tools = await getTools(cfg);
  } catch (e) {
    emit({ type: 'error', message: `Не удалось связаться с базой: ${e && e.message || e}` });
    return;
  }
  tools = tools.concat([REMEMBER_TOOL, EXPORT_TOOL, SAVE_FILE_TOOL, CHART_TOOL, FOLLOWUP_TOOL]);

  const refData = knowledge.readRefData(cfg.dataDir);
  const sysText = [SYSTEM, skills.buildText(cfg), knowledge.buildText(base), refData && ('== СПРАВОЧНЫЕ ДАННЫЕ ПОЛЬЗОВАТЕЛЯ ==\n' + refData)].filter(Boolean).join('\n\n');
  const systemBlocks = [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }];

  pushUser(userText);

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      compactHistory(HISTORY_TOKEN_BUDGET); // держим историю в пределах окна модели
      let msg;
      for (;;) {
        try {
          const params = {
            model,
            max_tokens: MAX_TOKENS,
            system: systemBlocks,
            tools,
            messages: history,
          };
          if (supportsEffort(model) && effortOk) params.output_config = { effort };
          emit({ type: 'model', model }); // индикатор фактической модели (учитывает переход по лимиту)
          const stream = client.messages.stream(params);
          stream.on('text', (delta) => emit({ type: 'text', delta }));
          msg = await stream.finalMessage();
          break;
        } catch (e) {
          if (e && e.status === 429) {
            if (onLimit === 'wait' && waited < WAIT_BUDGET_MS) {
              const w = retryAfterMs(e) || Math.min(30000, 5000 * Math.pow(2, waitStep));
              waitStep += 1; waited += w;
              emit({ type: 'notice', text: `⏳ Сейчас много обращений к AI. Подожду ${Math.round(w / 1000)} с и повторю…` });
              await sleep(w);
              continue;
            }
            if (onLimit !== 'error' && chain.length) {
              const nm = chain.shift();
              emit({ type: 'notice', text: `Отвечаю через более лёгкую модель, чтобы не ждать.` });
              model = nm;
              continue;
            }
            throw e;
          }
          if (e && e.status === 400 && effortOk && /output_config|effort/i.test(String((e && e.message) || ''))) {
            effortOk = false;
            continue;
          }
          throw e;
        }
      }
      history.push({ role: 'assistant', content: msg.content });
      emit({ type: 'assistant_done' });

      if (msg.stop_reason !== 'tool_use') break;

      const toolUses = msg.content.filter((b) => b.type === 'tool_use');
      toolUses.forEach((tu) => emit({ type: 'tool_use', name: tu.name, input: tu.input }));
      const results = await Promise.all(toolUses.map(async (tu) => {
       try {
        if (tu.name === 'export_to_excel') {
          try {
            const out = await writeExcel(cfg, tu.input || {});
            emit({ type: 'file', name: out.name, path: out.file, rows: out.rows });
            emit({ type: 'tool_result', name: 'export_to_excel', ok: true, preview: `Сохранено: ${out.name} (${out.rows} строк)` });
            return { type: 'tool_result', tool_use_id: tu.id, content: `Файл Excel сохранён: ${out.file} (строк: ${out.rows}). Пользователю показана кнопка «Открыть файл» — сообщи ему, что выгрузка готова.`, is_error: false };
          } catch (e) {
            const em = String(e && e.message || e);
            emit({ type: 'tool_result', name: 'export_to_excel', ok: false, preview: em });
            return { type: 'tool_result', tool_use_id: tu.id, content: 'Не удалось сохранить файл: ' + em, is_error: true };
          }
        }
        if (tu.name === 'create_chart') {
          emit({ type: 'chart', spec: tu.input || {} });
          return { type: 'tool_result', tool_use_id: tu.id, content: 'График показан пользователю.', is_error: false };
        }
        if (tu.name === 'suggest_followups') {
          const items = ((tu.input && tu.input.items) || []).filter(Boolean).slice(0, 4);
          emit({ type: 'followups', items });
          return { type: 'tool_result', tool_use_id: tu.id, content: 'Подсказки-продолжения показаны.', is_error: false };
        }
        if (tu.name === 'save_file') {
          try {
            const inp = tu.input || {};
            const fmt = ['csv', 'txt', 'md'].includes(inp.format) ? inp.format : 'txt';
            const file = uniquePath(cfg, inp.filename || 'Файл', fmt);
            let content = String(inp.content == null ? '' : inp.content);
            if (fmt === 'csv') content = '﻿' + content; // BOM — Excel корректно откроет кириллицу
            fs.writeFileSync(file, content, 'utf8');
            emit({ type: 'file', name: path.basename(file), path: file });
            emit({ type: 'tool_result', name: 'save_file', ok: true, preview: 'Сохранено: ' + path.basename(file) });
            return { type: 'tool_result', tool_use_id: tu.id, content: `Файл сохранён: ${file}. Пользователю показана кнопка «Открыть файл».`, is_error: false };
          } catch (e) {
            const em = String(e && e.message || e);
            emit({ type: 'tool_result', name: 'save_file', ok: false, preview: em });
            return { type: 'tool_result', tool_use_id: tu.id, content: 'Ошибка сохранения: ' + em, is_error: true };
          }
        }
        if (tu.name === 'remember') {
          const inp = tu.input || {};
          const n = knowledge.addLearned(base, inp.title, inp.content);
          emit({ type: 'tool_result', name: 'remember', ok: true, preview: `запомнено: ${inp.title || ''}` });
          return { type: 'tool_result', tool_use_id: tu.id, content: `Сохранено в память (всего заметок: ${n}).`, is_error: false };
        }
        if (READONLY_TOOLS.has(tu.name)) {
          const cached = knowledge.cacheGet(base, tu.name, tu.input);
          if (cached != null) {
            emit({ type: 'tool_result', name: tu.name, ok: true, preview: '(из кэша) ' + String(cached).slice(0, 380) });
            return { type: 'tool_result', tool_use_id: tu.id, content: capResult(cached), is_error: false };
          }
        }
        try {
          const r = await mcp.callTool(tu.name, tu.input);
          const text = toolResultText(r);
          if (READONLY_TOOLS.has(tu.name) && !(r && r.isError)) knowledge.cacheSet(base, tu.name, tu.input, text || '');
          if (!(r && r.isError) && (tu.name === 'get_structure' || (tu.name === 'describe' && tu.input && Object.keys(tu.input).length))) {
            knowledge.appendExplored(base, tu.name + '(' + JSON.stringify(tu.input) + ')', text || '');
          }
          // авто-копилка рабочих запросов: успешный запрос сохраняем как проверенный шаблон
          if (!(r && r.isError) && (tu.name === 'execute_query' || tu.name === 'query')) {
            const inp = tu.input || {};
            const qtext = inp.query || inp.text || inp.sql || inp.request || '';
            if (qtext) knowledge.appendQuery(base, qtext);
          }
          emit({ type: 'tool_result', name: tu.name, ok: !(r && r.isError), preview: (text || '').slice(0, 400) });
          return { type: 'tool_result', tool_use_id: tu.id, content: capResult(text || '(пустой результат)'), is_error: !!(r && r.isError) };
        } catch (e) {
          const em = String(e && e.message || e);
          emit({ type: 'tool_result', name: tu.name, ok: false, preview: em });
          return { type: 'tool_result', tool_use_id: tu.id, content: em, is_error: true };
        }
       } catch (e) {
          // Страховка: ЛЮБОЙ вызов инструмента обязан вернуть tool_result,
          // иначе в истории останется висячий tool_use → API отдаст 400.
          const em = String(e && e.message || e);
          emit({ type: 'tool_result', name: tu.name, ok: false, preview: em });
          return { type: 'tool_result', tool_use_id: tu.id, content: em, is_error: true };
        }
      }));
      history.push({ role: 'user', content: results });
    }
    persist();
    emit({ type: 'done' });
  } catch (e) {
    persist();
    emit({ type: 'error', message: formatApiError(e) });
  }
}

// Режим «Через Claude Code»: диалог ведёт CLI Claude Code как подпроцесс.
// К базе он подключается сам (MCP RSV Data, только чтение); мы стримим его события в UI
// и сохраняем текст в историю (для сайдбара и перезагрузки диалога).
async function sendViaClaudeCode(cfg, userText, emit) {
  const a = activeBase(cfg);
  const base = a.url;
  if (!base) {
    emit({ type: 'error', message: 'Не подключена база. Откройте «Подключить базу» и введите данные доступа.' });
    return;
  }
  if (!currentBase) currentBase = base;

  if (!claudecode.resolveCli()) {
    emit({ type: 'error', message: 'Режим «Через Claude Code» требует установленного на этом компьютере Claude Code (с выполненным входом в аккаунт). Установите Claude Code или переключите «Движок ответа» на «Напрямую (API)» в настройках → Доступ к AI.' });
    return;
  }

  const refData = knowledge.readRefData(cfg.dataDir);
  const sysText = [SYSTEM_CC, skills.buildText(cfg), knowledge.buildText(base), refData && ('== СПРАВОЧНЫЕ ДАННЫЕ ПОЛЬЗОВАТЕЛЯ ==\n' + refData)].filter(Boolean).join('\n\n');
  const model = cfg.aiModel || DEFAULT_MODEL;
  const apiKey = (cfg.aiApiKey || '').trim(); // если задан — CLI пойдёт по ключу, иначе по подписке

  pushUser(userText);

  const resume = !!ccSessionId;
  if (!ccSessionId) ccSessionId = crypto.randomUUID();

  // Обёртка над emit: (1) прячем служебный маркер §ЗНАНИЕ§ из показа;
  // (2) авто-копилка рабочих запросов — успешный query/execute_query сохраняем как шаблон.
  const SENT = '§ЗНАНИЕ§';
  let cutting = false, pend = '';
  const pendTools = {};
  const wrapEmit = (evt) => {
    if (evt.type === 'text') {
      if (cutting) return;
      pend += evt.delta;
      const idx = pend.indexOf(SENT);
      if (idx >= 0) { const before = pend.slice(0, idx); if (before) emit({ type: 'text', delta: before }); pend = ''; cutting = true; return; }
      const keep = SENT.length - 1;
      if (pend.length > keep) { emit({ type: 'text', delta: pend.slice(0, pend.length - keep) }); pend = pend.slice(pend.length - keep); }
      return;
    }
    if (evt.type === 'assistant_done') {
      if (!cutting && pend) { emit({ type: 'text', delta: pend }); } pend = ''; cutting = false;
      emit(evt); return;
    }
    if (evt.type === 'tool_use') { (pendTools[evt.name] = pendTools[evt.name] || []).push(evt.input || {}); emit(evt); return; }
    if (evt.type === 'tool_result') {
      if (evt.ok && (evt.name === 'query' || evt.name === 'execute_query')) {
        const inp = (pendTools[evt.name] || []).shift() || {};
        const qtext = inp.query || inp.text || inp.sql || inp.request || '';
        if (qtext) { try { knowledge.appendQuery(base, qtext); } catch (_) {} }
      }
      emit(evt); return;
    }
    emit(evt);
  };

  try {
    const res = await claudecode.run({ base: a, sysText, userText, model, apiKey, sessionId: ccSessionId, resume, emit: wrapEmit });
    if (res && res.sessionId) ccSessionId = res.sessionId;
    // Выделяем накопленные факты из ответа и сохраняем; в историю кладём текст без служебных строк.
    const parsed = stripFacts((res && res.text) || '');
    for (const f of parsed.facts) { try { knowledge.addLearned(base, f.title, f.content); } catch (_) {} }
    if (parsed.clean) history.push({ role: 'assistant', content: [{ type: 'text', text: parsed.clean }] });
    persist();
    if (res && res.isError && res.errorMessage) emit({ type: 'notice', text: res.errorMessage });
    emit({ type: 'done' });
  } catch (e) {
    ccSessionId = null; // сбой запуска — начнём сессию заново со следующего вопроса
    persist();
    emit({ type: 'error', message: 'Claude Code: ' + String((e && e.message) || e) });
  }
}

// Выделить служебные строки «§ЗНАНИЕ§ Заголовок :: Содержание» из текста ответа.
function stripFacts(text) {
  const facts = [];
  const kept = [];
  for (const ln of String(text || '').split(/\r?\n/)) {
    const m = /^\s*§ЗНАНИЕ§\s*(.+?)\s*::\s*(.+)$/.exec(ln);
    if (m) facts.push({ title: m[1], content: m[2] });
    else kept.push(ln);
  }
  return { clean: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), facts };
}

// Статус режима «Через Claude Code» для настроек (установлен ли CLI + версия).
async function ccStatus() {
  try { return await claudecode.available(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function authStatus(cfg) { return credStatus(cfg); }

// Какие модели реально отвечают с текущей авторизацией (быстро, без ретраев).
async function testModels(cfg) {
  const cred = resolveCredential(cfg);
  if (cred.mode === 'none') return { error: noCredMessage(cred) };
  const client = buildClient(cred, 0);
  const models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  const results = [];
  for (const m of models) {
    try { await client.messages.create({ model: m, max_tokens: 4, messages: [{ role: 'user', content: 'ok' }] }); results.push({ model: m, ok: true }); }
    catch (e) { results.push({ model: m, ok: false, status: (e && e.status) || 0 }); }
  }
  return { results, mode: cred.mode, source: cred.source };
}

// Живая проверка связи с Claude: реальный мини-запрос (Haiku — отдельный лимит).
async function testAuth(cfg) {
  const cred = resolveCredential(cfg);
  if (cred.mode === 'none') return { ok: false, error: noCredMessage(cred) };
  try {
    const client = buildClient(cred);
    await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 4, messages: [{ role: 'user', content: 'ok' }] });
    return { ok: true, mode: cred.mode, source: cred.source };
  } catch (e) {
    return { ok: false, error: formatApiError(e), mode: cred.mode, source: cred.source };
  }
}

// Прогрев: подтягиваем инструменты RSV Data и авто-собираем паспорт/состав базы.
async function warm(cfg) {
  try { await getTools(cfg); autoCollect(cfg).catch(() => {}); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Авто-сбор знаний о базе: help + config (паспорт) + describe (состав) → auto.md.
async function autoCollect(cfg, force) {
  const base = activeBase(cfg).url;
  if (!base) return { ok: false, error: 'нет базы' };
  if (!force && knowledge.hasAuto(base)) return { ok: true, cached: true };
  if (!mcp) mcp = makeMcp(cfg);
  const grab = async (t) => { try { return toolResultText(await mcp.callTool(t, {})); } catch (_) { return ''; } };
  const help = await grab('help');
  const config = await grab('config');
  const describe = await grab('describe');
  const doc = [
    help && ('# Справка сервиса\n' + help),
    config && ('# Паспорт базы (config)\n' + config),
    describe && ('# Состав базы (describe)\n' + describe),
  ].filter(Boolean).join('\n\n');
  if (doc) knowledge.saveAuto(base, doc);
  return { ok: !!doc, chars: doc.length };
}

async function collectBase(cfg) { return autoCollect(cfg, true); }

// Выгрузка таблицы в .xlsx по запросу из UI (кнопка «Скачать в Excel» под таблицей).
async function exportTable(cfg, input) { return writeExcel(cfg, input); }

// Сведения о знаниях активной базы (для раздела «Знания»).
function getKnowledge(cfg) {
  const a = activeBase(cfg); const base = a.url;
  if (!base) return { base: '', baseName: '', user: '', hasAuto: false, autoChars: 0, exploredCount: 0, learnedCount: 0 };
  return {
    base,
    baseName: a.name || knowledge.baseNameFromUrl(base),
    user: knowledge.getUser(base) || '',
    hasAuto: knowledge.hasAuto(base),
    autoChars: (knowledge.getAuto(base) || '').length,
    exploredCount: knowledge.exploredCount(base),
    learnedCount: (knowledge.getLearned(base) || []).length,
    queriesCount: knowledge.queriesCount(base),
    learned: (knowledge.getLearned(base) || []).slice(-30).reverse(),
  };
}
// Сохранить заметки пользователя для активной базы (per-base).
function saveUserKnowledge(cfg, text) { const base = activeBase(cfg).url; return base ? knowledge.saveUser(base, text) : false; }

// Сброс накопленной памяти о текущей базе (паспорт/изученное/заметки/кэш).
function clearKnowledge(cfg) {
  const base = activeBase(cfg).url;
  if (!base) return false;
  try {
    knowledge.saveAuto(base, '');
    knowledge.clearExplored(base);
    knowledge.clearLearned(base);
    knowledge.clearQueries(base);
    knowledge.clearCache();
  } catch (_) { return false; }
  return true;
}

module.exports = {
  send, resetConversation, invalidate, pingRsv, testBase, authStatus, testAuth, warm,
  listChats, loadChat, deleteChat, clearChats, collectBase, exportTable, clearKnowledge,
  getKnowledge, saveUserKnowledge, testModels, currentChatId, ccStatus,
};
