'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { extractQuotaStateFromText, parseResetLabelToIso } = require('../server/quota-parser');

function fixtureText(fileName) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', fileName), 'utf8');
  return new JSDOM(html).window.document.body.textContent;
}

test('extractQuotaStateFromText parses expanded menu', () => {
  const result = extractQuotaStateFromText(fixtureText('quota-expanded.html'), {
    nowIso: '2026-03-20T10:00:00.000Z',
    timezoneOffsetMinutes: -480
  });

  assert.equal(result.parserStatus, 'ok');
  assert.equal(result.fiveHour.percent, 0);
  assert.equal(result.fiveHour.resetLabel, '20:00');
  assert.ok(result.fiveHour.resetAt);
  assert.equal(result.week.percent, 99);
  assert.equal(result.week.resetLabel, '3月27日');
});

test('extractQuotaStateFromText returns unknown when week row is missing', () => {
  const result = extractQuotaStateFromText(fixtureText('quota-missing-week.html'), {
    nowIso: '2026-03-20T10:00:00.000Z',
    timezoneOffsetMinutes: -480
  });

  assert.equal(result.parserStatus, 'unknown');
  assert.equal(result.fiveHour.percent, 40);
  assert.equal(result.week, null);
});

test('parseResetLabelToIso rolls time labels to next day when needed', () => {
  const resetAt = parseResetLabelToIso('01:00', '2026-03-20T18:00:00.000Z', 0);
  assert.equal(resetAt, '2026-03-21T01:00:00.000Z');
});
