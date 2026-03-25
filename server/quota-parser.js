'use strict';

function normalizeSpace(text) {
  return String(text || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function parsePercent(text) {
  const match = normalizeSpace(text).match(/(\d{1,3})\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseResetLabelToIso(label, nowIso, timezoneOffsetMinutes = 0) {
  const clean = normalizeSpace(label);
  if (!clean) return null;

  const now = new Date(nowIso || Date.now());
  const localMs = now.getTime() - timezoneOffsetMinutes * 60 * 1000;
  const localNow = new Date(localMs);

  const timeMatch = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const targetLocal = new Date(Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate(),
      hour,
      minute,
      0,
      0
    ));
    if (targetLocal.getTime() <= localNow.getTime()) {
      targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
    }
    return new Date(targetLocal.getTime() + timezoneOffsetMinutes * 60 * 1000).toISOString();
  }

  const dateMatch = clean.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (dateMatch) {
    const month = Number(dateMatch[1]) - 1;
    const date = Number(dateMatch[2]);
    const targetLocal = new Date(Date.UTC(localNow.getUTCFullYear(), month, date, 0, 0, 0, 0));
    if (targetLocal.getTime() < Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 0, 0, 0, 0)) {
      targetLocal.setUTCFullYear(targetLocal.getUTCFullYear() + 1);
    }
    return new Date(targetLocal.getTime() + timezoneOffsetMinutes * 60 * 1000).toISOString();
  }

  return null;
}

function extractQuotaStateFromText(text, options = {}) {
  const normalized = normalizeSpace(text);
  const rowPattern = /(5 小时|1 周)\s+(\d{1,3}\s*%)\s*[·•]?\s*([0-9]{1,2}:\d{2}|\d{1,2}月\d{1,2}日)/g;
  const rows = [];
  let match;
  while ((match = rowPattern.exec(normalized)) !== null) {
    rows.push({
      label: match[1],
      percent: parsePercent(match[2]),
      resetLabel: normalizeSpace(match[3]),
      resetAt: parseResetLabelToIso(match[3], options.nowIso, options.timezoneOffsetMinutes || 0)
    });
  }

  const fiveHour = rows.find((row) => row.label === '5 小时') || null;
  const week = rows.find((row) => row.label === '1 周') || null;

  return {
    parserStatus: fiveHour && week ? 'ok' : 'unknown',
    fiveHour,
    week
  };
}

module.exports = {
  extractQuotaStateFromText,
  normalizeSpace,
  parsePercent,
  parseResetLabelToIso
};
