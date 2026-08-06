'use strict';
// Клиент MCP поверх HTTP (Streamable HTTP) для локального сервиса RSV Data (1С HTTP-сервис).
// Серверный MCP-коннектор Anthropic сюда не годится — сервис в локальной сети,
// серверы Anthropic до него не достучатся. Поэтому ходим из main-процесса приложения.

let _id = 0;
function nextId() { _id += 1; return _id; }

// Разбор ответа: сервис может вернуть либо чистый JSON, либо SSE (text/event-stream).
function parseBody(contentType, text) {
  if (contentType && /text\/event-stream/i.test(contentType)) {
    // Собираем JSON из строк "data: {...}" — берём последний валидный JSON-RPC ответ.
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1].trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        if (j && (j.result !== undefined || j.error !== undefined)) last = j;
      } catch (_) { /* частичный кусок — пропускаем */ }
    }
    return last;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

class RsvMcp {
  constructor({ url, auth }) {
    this.url = url;
    this.auth = auth || '';
    this.sessionId = null;
    this.initialized = false;
    this.protocolVersion = '2025-06-18';
  }

  _headers(extra) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.auth) h['Authorization'] = this.auth;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return Object.assign(h, extra || {});
  }

  // Один JSON-RPC запрос. isNotification — без ожидания результата (id отсутствует).
  async _rpc(method, params, { notification = false } = {}) {
    const body = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    if (!notification) body.id = nextId();

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Нет связи с базой (${this.url}): ${e && e.message || e}`);
    }

    // Захватываем session-id при инициализации.
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (notification) return null;

    const ct = res.headers.get('content-type') || '';
    const text = await res.text();

    if (!res.ok) {
      const parsed = parseBody(ct, text);
      const msg = parsed && parsed.error && parsed.error.message;
      throw new Error(`Ошибка базы HTTP ${res.status}: ${msg || text.slice(0, 300)}`);
    }

    const parsed = parseBody(ct, text);
    if (!parsed) throw new Error(`База: не удалось разобрать ответ (${ct}): ${text.slice(0, 300)}`);
    if (parsed.error) throw new Error(`База: ${parsed.error.message || JSON.stringify(parsed.error)}`);
    return parsed.result;
  }

  async ensureInit() {
    if (this.initialized) return;
    await this._rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: '1c-assistant', version: '0.1.0' },
    });
    // Уведомление о завершении инициализации (спецификация MCP). Ошибки терпим.
    try { await this._rpc('notifications/initialized', undefined, { notification: true }); } catch (_) {}
    this.initialized = true;
  }

  async listTools() {
    await this.ensureInit();
    const r = await this._rpc('tools/list', {});
    return (r && r.tools) || [];
  }

  async callTool(name, args) {
    await this.ensureInit();
    return this._rpc('tools/call', { name, arguments: args || {} });
  }

  async ping() {
    // Лёгкая проверка соединения: init + список инструментов.
    const tools = await this.listTools();
    return { ok: true, tools: tools.length, session: this.sessionId };
  }
}

// Преобразование результата MCP tools/call → строка для tool_result Anthropic.
function toolResultText(result) {
  if (result == null) return '';
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c == null) return '';
        if (typeof c === 'string') return c;
        if (c.type === 'text') return c.text || '';
        if (c.type === 'resource' && c.resource) return c.resource.text || JSON.stringify(c.resource);
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

module.exports = { RsvMcp, toolResultText };
