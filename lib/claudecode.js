'use strict';
// Режим «Через Claude Code»: вместо прямого вызова Anthropic SDK запускаем локальный
// CLI Claude Code (claude -p ...) как подпроцесс. Это санкционированный клиент подписки,
// поэтому сильные модели (Sonnet/Opus) работают надёжно, без «серых» 429, которые ловит
// прямой вызов SDK с OAuth-токеном. К базе 1С Claude Code подключается сам — отдаём ему
// MCP-конфиг RSV Data (только чтение). Так же работает приложение Dereu (агент = claude-code).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ------- расположение бинаря claude -------
let _cli = undefined; // undefined — ещё не искали; null — не найден; string — путь

function candidatePaths() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const list = [];
  if (process.env.CLAUDE_CLI_PATH) list.push(process.env.CLAUDE_CLI_PATH);
  // Нативный установщик Claude Code
  list.push(path.join(home, '.local', 'bin', 'claude.exe'));
  list.push(path.join(home, '.local', 'bin', 'claude'));
  // Глобальная установка через npm
  list.push(path.join(appdata, 'npm', 'claude.cmd'));
  list.push(path.join(appdata, 'npm', 'claude'));
  list.push(path.join(home, '.npm-global', 'bin', 'claude'));
  // Возможные *nix-пути (на случай запуска не под Windows)
  list.push('/usr/local/bin/claude');
  list.push('/opt/homebrew/bin/claude');
  return list;
}

function resolveCli(force) {
  if (!force && _cli !== undefined) return _cli;
  _cli = null;
  for (const p of candidatePaths()) {
    try { if (p && fs.existsSync(p)) { _cli = p; break; } } catch (_) { /* ignore */ }
  }
  return _cli;
}

// Рабочая папка для сессий Claude Code (стабильная — чтобы работал --resume).
let _wsDir = null;
function workspaceDir() {
  if (_wsDir) return _wsDir;
  let base;
  try { base = require('electron').app.getPath('userData'); } catch (_) { base = path.join(os.tmpdir(), '1c-assistant'); }
  _wsDir = path.join(base, 'cc-workspace');
  try { fs.mkdirSync(_wsDir, { recursive: true }); } catch (_) { /* ignore */ }
  return _wsDir;
}

function tmpDir() {
  const d = path.join(workspaceDir(), '.run');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
  return d;
}

// Проверка доступности CLI: путь + версия (быстро, с таймаутом).
function available() {
  return new Promise((resolve) => {
    const cli = resolveCli(true);
    if (!cli) return resolve({ ok: false, error: 'not-installed' });
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(cli, ['--version'], { windowsHide: true });
    } catch (e) {
      return finish({ ok: false, error: String(e && e.message || e), path: cli });
    }
    const to = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ ok: false, error: 'timeout', path: cli }); }, 8000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: String(e && e.message || e), path: cli }); });
    child.on('close', () => {
      clearTimeout(to);
      const version = (out.trim().split(/\s+/)[0]) || '';
      finish({ ok: !!version, version, path: cli });
    });
  });
}

// MCP-конфиг для CLI: HTTP-сервер RSV Data активной базы (авторизация — тот же заголовок).
function writeMcpConfig(base) {
  const headers = {};
  if (base && base.auth) headers.Authorization = base.auth;
  const cfg = { mcpServers: { 'rsv-data': { type: 'http', url: base.url, headers } } };
  const file = path.join(tmpDir(), 'mcp-config.json');
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
  return file;
}

function writeSysPrompt(text) {
  const file = path.join(tmpDir(), 'system-prompt.txt');
  fs.writeFileSync(file, String(text || ''), 'utf8');
  return file;
}

// Инструменты Claude Code, которые НЕ нужны ассистенту базы (запрещаем — чтобы был
// исключительно доступ к базе на чтение, без файловой системы/интернета/шелла).
const DISALLOWED = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'];

// Имя MCP-инструмента вида mcp__rsv-data__query → query (чтобы совпадало с ярлыками UI).
function shortToolName(n) { return String(n || '').replace(/^mcp__.*?__/, ''); }

function blockText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === 'text' ? (c.text || '') : (typeof c === 'string' ? c : JSON.stringify(c)))).join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Запуск одного хода диалога через Claude Code.
 * @param opts { base, sysText, userText, model, apiKey, sessionId, resume, emit }
 * @returns Promise<{ text, sessionId, isError, errorMessage }>
 */
function run(opts) {
  const { base, sysText, userText, model, apiKey, sessionId, resume, emit } = opts;
  const cli = resolveCli();
  return new Promise((resolve, reject) => {
    if (!cli) return reject(new Error('Claude Code не установлен на этом компьютере.'));

    const mcpFile = writeMcpConfig(base);
    const sysFile = writeSysPrompt(sysText);

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model || 'claude-sonnet-5',
      '--fallback-model', 'claude-haiku-4-5',
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', 'mcp__rsv-data',
      '--disallowedTools', ...DISALLOWED,
      '--append-system-prompt-file', sysFile,
    ];
    if (resume && sessionId) args.push('--resume', sessionId);
    else if (sessionId) args.push('--session-id', sessionId);

    const env = Object.assign({}, process.env);
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey; // если админ задал ключ — CLI пойдёт по ключу
    // Не мешаем CLI использовать вход Claude с этого ПК (подписку), если ключа нет.

    let child;
    try {
      child = spawn(cli, args, { cwd: workspaceDir(), env, windowsHide: true });
    } catch (e) {
      return reject(new Error('Не удалось запустить Claude Code: ' + (e && e.message || e)));
    }

    const idToName = {};
    let acc = '';           // накопленный текст ответа (на случай отсутствия result.result)
    let streamedTurn = false; // стримили ли текст этого хода дельтами
    let curSession = sessionId || null;
    let lastModel = '';
    let finalText = '';
    let isError = false;
    let errorMessage = '';
    let settled = false;
    let stderr = '';
    let buf = '';

    const to = setTimeout(() => { try { child.kill(); } catch (_) {} finishErr('Превышено время ожидания ответа Claude Code.'); }, 240000);

    function finishOk() {
      if (settled) return; settled = true; clearTimeout(to);
      resolve({ text: finalText || acc, sessionId: curSession, isError, errorMessage });
    }
    function finishErr(msg) {
      if (settled) return; settled = true; clearTimeout(to);
      reject(new Error(msg));
    }

    function handle(obj) {
      if (!obj || typeof obj !== 'object') return;
      const t = obj.type;
      if (t === 'system' && obj.subtype === 'init') {
        if (obj.session_id) curSession = obj.session_id;
        return;
      }
      if (t === 'stream_event' && obj.event) {
        const ev = obj.event;
        if (ev.type === 'message_start') { streamedTurn = false; return; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          const d = ev.delta.text || '';
          if (d) { acc += d; streamedTurn = true; emit && emit({ type: 'text', delta: d }); }
        }
        return;
      }
      if (t === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        if (obj.message.model && obj.message.model !== lastModel) {
          lastModel = obj.message.model;
          emit && emit({ type: 'model', model: lastModel });
        }
        for (const b of obj.message.content) {
          if (b && b.type === 'text') {
            // если текст уже пришёл дельтами — не дублируем
            if (!streamedTurn && b.text) { acc += b.text; emit && emit({ type: 'text', delta: b.text }); }
          } else if (b && b.type === 'tool_use') {
            // показываем в UI только реальные обращения к базе (mcp__rsv-data__*);
            // служебные инструменты Claude Code (ToolSearch и пр.) скрываем.
            if (typeof b.name === 'string' && b.name.startsWith('mcp__')) {
              const nm = shortToolName(b.name);
              idToName[b.id] = nm;
              emit && emit({ type: 'tool_use', name: nm, input: b.input || {} });
            }
          }
        }
        emit && emit({ type: 'assistant_done' });
        streamedTurn = false;
        return;
      }
      if (t === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const b of obj.message.content) {
          if (b && b.type === 'tool_result') {
            const nm = idToName[b.tool_use_id];
            if (!nm) continue; // результат служебного инструмента — не показываем
            const preview = blockText(b.content).slice(0, 400);
            emit && emit({ type: 'tool_result', name: nm, ok: !b.is_error, preview });
          }
        }
        return;
      }
      if (t === 'result') {
        if (typeof obj.result === 'string' && obj.result) finalText = obj.result;
        if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
          isError = true;
          if (obj.subtype === 'error_max_turns') errorMessage = 'Достигнут предел шагов — ответ может быть неполным.';
          else errorMessage = (typeof obj.result === 'string' && obj.result) || 'Claude Code завершился с ошибкой.';
        }
        return;
      }
    }

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch (_) { /* неполная/непарсируемая строка */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finishErr('Ошибка запуска Claude Code: ' + (e && e.message || e)));
    child.on('close', (code) => {
      // добираем остаток буфера
      const rest = buf.trim();
      if (rest) { try { handle(JSON.parse(rest)); } catch (_) {} }
      if (settled) return;
      if (code !== 0 && !finalText && !acc) {
        return finishErr(stderr.trim().slice(-500) || ('Claude Code завершился с кодом ' + code + '.'));
      }
      finishOk();
    });

    // Промпт пользователя — через stdin (без проблем с длиной/кавычками/спецсимволами).
    try { child.stdin.write(String(userText || '')); child.stdin.end(); } catch (_) { /* ignore */ }
  });
}

module.exports = { resolveCli, available, run, workspaceDir };
