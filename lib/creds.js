'use strict';
// Разрешение учётных данных Anthropic без ручного ввода ключа.
// Приоритет: 1) ключ из настроек → 2) переменная окружения → 3) учётная запись Claude
// с этого компьютера (OAuth-токен, который оставляет вход через Claude Code / браузер).
//
// ВАЖНО: сессия claude.ai в браузере (куки) для вызова API непригодна — это другая
// система авторизации. Но вход через Claude Code делает OAuth к аккаунту Claude и
// сохраняет токен со scope user:inference в ~/.claude/.credentials.json — его и берём.
const fs = require('fs');
const os = require('os');
const path = require('path');

function claudeCredPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

// Читаем свежий токен при каждом обращении (Claude Code обновляет его сам).
function readClaudeAccount() {
  try {
    const p = claudeCredPath();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const o = j && j.claudeAiOauth;
    if (!o || !o.accessToken) return null;
    const sub = o.subscriptionType ? `подписка ${o.subscriptionType}` : 'аккаунт';
    const expired = o.expiresAt ? Date.now() >= o.expiresAt : false;
    return {
      token: o.accessToken,
      expiresAt: o.expiresAt || null,
      expired,
      source: `Claude на этом ПК (${sub})`,
    };
  } catch (_) {
    return null;
  }
}

// Возвращает {mode:'apikey'|'oauth'|'none', ...} — без утечки токена наружу без нужды.
function resolveCredential(settings) {
  const s = settings || {};
  const key = (s.aiApiKey || '').trim();
  if (key) return { mode: 'apikey', apiKey: key, source: 'ключ в настройках' };

  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: 'apikey', apiKey: process.env.ANTHROPIC_API_KEY, source: 'переменная окружения ANTHROPIC_API_KEY' };
  }

  const useAccount = s.aiUseAccount !== false; // по умолчанию включено
  if (useAccount) {
    const acc = readClaudeAccount();
    if (acc && !acc.expired) {
      return { mode: 'oauth', token: acc.token, source: acc.source, expiresAt: acc.expiresAt };
    }
    if (acc && acc.expired) {
      return { mode: 'none', reason: 'account-expired', source: acc.source };
    }
  }
  return { mode: 'none', reason: 'no-credential' };
}

// Безопасный статус для UI — без токена.
function credStatus(settings) {
  const c = resolveCredential(settings);
  return { mode: c.mode, source: c.source || '', reason: c.reason || '' };
}

module.exports = { resolveCredential, credStatus };
