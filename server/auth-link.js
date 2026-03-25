'use strict';

const { URL } = require('url');

function buildManagedAuthUrl(inputUrl, preferredEmail = '') {
  const fallback = 'https://auth.openai.com/codex/device';
  const baseUrl = inputUrl || fallback;
  const email = String(preferredEmail || '').trim().toLowerCase();

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('prompt', 'login');
    url.searchParams.set('max_age', '0');
    if (email) url.searchParams.set('login_hint', email);
    return url.toString();
  } catch (_) {
    const params = new URLSearchParams({
      prompt: 'login',
      max_age: '0'
    });
    if (email) params.set('login_hint', email);
    return `${fallback}?${params.toString()}`;
  }
}

module.exports = {
  buildManagedAuthUrl
};
