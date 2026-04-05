'use strict';

const {
  createAccount,
  createAuthProfile,
  db,
  deleteAuthProfile,
  getAuthProfileByIdentityKey,
  getPrimaryAuthProfileForSlot,
  getSlotByEmail,
  getSlotById,
  listAuthProfilesForSlot,
  listSlots,
  nowIso,
  setPrimaryAuthProfile,
  syncSlotAuthAggregate,
  updateAuthProfile,
  updateSlot,
  upsertProfile
} = require('./db');
const {
  decryptWithPassphrase,
  encryptWithPassphrase
} = require('./security');

const EXPORT_SCHEMA_VERSION = 'codex-switcher-export-v1';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStrategy(value) {
  return ['merge', 'replace', 'skip'].includes(value) ? value : 'merge';
}

function serializeExportAccount(slot) {
  return {
    slot: {
      id: slot.id,
      label: slot.label || '',
      email: slot.email || '',
      login_method: slot.login_method || 'email',
      expires_at: slot.expires_at || '',
      state: slot.state || 'draft',
      last_bootstrap_at: slot.last_bootstrap_at || null,
      last_seen_at: slot.last_seen_at || null,
      freshness: slot.freshness || 'stale',
      last_error: slot.last_error || null
    },
    ui: {
      primary_auth_profile_id: slot.primary_auth_profile_id || null,
      active_auth_profile_id: slot.active_auth_profile_id || null
    },
    auth_profiles: listAuthProfilesForSlot(slot.id).map((profile) => ({
      id: profile.id,
      workspace_label: profile.workspace_label || '未命名认证',
      account_id: profile.account_id || null,
      identity_key: profile.identity_key || null,
      auth_cipher: profile.auth_cipher,
      is_primary: !!profile.is_primary,
      freshness: profile.freshness || 'stale',
      quota_5h_pct: profile.quota_5h_pct == null ? null : profile.quota_5h_pct,
      quota_5h_reset_at: profile.quota_5h_reset_at || null,
      quota_5h_reset_label: profile.quota_5h_reset_label || null,
      quota_week_pct: profile.quota_week_pct == null ? null : profile.quota_week_pct,
      quota_week_reset_at: profile.quota_week_reset_at || null,
      quota_week_reset_label: profile.quota_week_reset_label || null,
      last_seen_at: profile.last_seen_at || null,
      last_error: profile.last_error || null,
      created_at: profile.created_at || null,
      updated_at: profile.updated_at || null
    }))
  };
}

function buildExchangeDocument(source = 'codex-switcher-web') {
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: nowIso(),
    source,
    accounts: listSlots().map(serializeExportAccount)
  };
}

function exportExchangeEnvelope(passphrase, options = {}) {
  const document = buildExchangeDocument(options.source || 'codex-switcher-web');
  return {
    schema_version: document.schema_version,
    exported_at: document.exported_at,
    source: document.source,
    encryption: encryptWithPassphrase(JSON.stringify(document), passphrase)
  };
}

function parseExchangeEnvelope(envelope, passphrase) {
  if (!envelope || envelope.schema_version !== EXPORT_SCHEMA_VERSION) {
    throw new Error('UNSUPPORTED_EXCHANGE_SCHEMA');
  }
  let decrypted;
  try {
    decrypted = decryptWithPassphrase(envelope.encryption, passphrase);
  } catch (error) {
    if (String(error.message || '') === 'UNSUPPORTED_ENCRYPTION') throw error;
    throw new Error('EXCHANGE_DECRYPT_FAILED');
  }
  let parsed;
  try {
    parsed = JSON.parse(decrypted);
  } catch (_) {
    throw new Error('INVALID_EXCHANGE_PAYLOAD');
  }
  if (!parsed || parsed.schema_version !== EXPORT_SCHEMA_VERSION || !Array.isArray(parsed.accounts)) {
    throw new Error('INVALID_EXCHANGE_PAYLOAD');
  }
  return parsed;
}

function buildSlotPatch(existingSlot, incomingSlot, strategy, hasProfiles) {
  const replace = strategy === 'replace';
  const patch = {};
  const nextEmail = normalizeEmail(incomingSlot.email);
  const nextLabel = normalizeText(incomingSlot.label || incomingSlot.email);
  const nextLoginMethod = normalizeText(incomingSlot.login_method || 'email');
  const nextExpiry = normalizeText(incomingSlot.expires_at);

  if (replace || nextLabel) patch.label = nextLabel || existingSlot.label || '';
  if (replace || nextEmail) patch.email = nextEmail || existingSlot.email || '';
  if (replace || nextLoginMethod) patch.login_method = nextLoginMethod || existingSlot.login_method || 'email';
  if (replace || nextExpiry) patch.expires_at = nextExpiry || existingSlot.expires_at || '';
  if (replace || incomingSlot.last_bootstrap_at) patch.last_bootstrap_at = incomingSlot.last_bootstrap_at || null;
  if (replace || incomingSlot.last_error) patch.last_error = incomingSlot.last_error || null;

  if (replace) {
    patch.state = incomingSlot.state || (hasProfiles ? 'ready' : 'auth_required');
  } else if (existingSlot.state === 'draft' && patch.email && patch.login_method && patch.expires_at) {
    patch.state = hasProfiles ? 'ready' : 'auth_required';
  }
  return patch;
}

function resolveMatchedSlot(incomingAccount) {
  for (const authProfile of incomingAccount.auth_profiles || []) {
    if (authProfile.identity_key) {
      const existing = getAuthProfileByIdentityKey(authProfile.identity_key);
      if (existing) return getSlotById(existing.slot_id);
    }
  }
  const email = normalizeEmail(incomingAccount.slot && incomingAccount.slot.email);
  if (email) return getSlotByEmail(email);
  return null;
}

function resolveMatchedProfile(slotId, importedProfile) {
  if (importedProfile.identity_key) {
    const existing = getAuthProfileByIdentityKey(importedProfile.identity_key);
    if (existing) return existing;
  }
  return listAuthProfilesForSlot(slotId).find((profile) => (
    normalizeText(profile.workspace_label).toLowerCase() === normalizeText(importedProfile.workspace_label).toLowerCase()
  )) || null;
}

function buildAuthProfilePatch(importedProfile, existingProfile) {
  return {
    workspace_label: normalizeText(importedProfile.workspace_label) || existingProfile.workspace_label || '未命名认证',
    auth_cipher: importedProfile.auth_cipher || existingProfile.auth_cipher,
    account_id: importedProfile.account_id || null,
    identity_key: importedProfile.identity_key || null,
    freshness: importedProfile.freshness || existingProfile.freshness || 'stale',
    quota_5h_pct: importedProfile.quota_5h_pct == null ? null : importedProfile.quota_5h_pct,
    quota_5h_reset_at: importedProfile.quota_5h_reset_at || null,
    quota_5h_reset_label: importedProfile.quota_5h_reset_label || null,
    quota_week_pct: importedProfile.quota_week_pct == null ? null : importedProfile.quota_week_pct,
    quota_week_reset_at: importedProfile.quota_week_reset_at || null,
    quota_week_reset_label: importedProfile.quota_week_reset_label || null,
    last_seen_at: importedProfile.last_seen_at || null,
    last_error: importedProfile.last_error || null
  };
}

function importExchangeEnvelope(envelope, passphrase, options = {}) {
  const strategy = normalizeStrategy(options.strategy);
  const document = parseExchangeEnvelope(envelope, passphrase);
  const result = {
    schema_version: document.schema_version,
    strategy,
    imported_at: nowIso(),
    created_accounts: 0,
    updated_accounts: 0,
    skipped_accounts: 0,
    created_auth_profiles: 0,
    updated_auth_profiles: 0,
    deleted_auth_profiles: 0,
    skipped_auth_profiles: 0,
    conflicts: []
  };

  const tx = db.transaction(() => {
    for (const incomingAccount of document.accounts) {
      const matchedSlot = resolveMatchedSlot(incomingAccount);
      if (matchedSlot && strategy === 'skip') {
        result.skipped_accounts += 1;
        continue;
      }

      let targetSlot = matchedSlot;
      if (!targetSlot) {
        targetSlot = createAccount();
        result.created_accounts += 1;
      } else {
        result.updated_accounts += 1;
      }

      const patch = buildSlotPatch(targetSlot, incomingAccount.slot || {}, strategy, Array.isArray(incomingAccount.auth_profiles) && incomingAccount.auth_profiles.length > 0);
      if (Object.keys(patch).length) updateSlot(targetSlot.id, patch);

      const importedProfiles = Array.isArray(incomingAccount.auth_profiles) ? incomingAccount.auth_profiles : [];
      const existingProfiles = listAuthProfilesForSlot(targetSlot.id);
      const keptProfileIds = new Set();
      let nextPrimaryId = null;

      for (const importedProfile of importedProfiles) {
        const matchedProfile = resolveMatchedProfile(targetSlot.id, importedProfile);
        if (matchedProfile && matchedProfile.slot_id !== targetSlot.id) {
          throw new Error('EXCHANGE_PROFILE_CONFLICT_OTHER_ACCOUNT');
        }

        const duplicateWorkspace = listAuthProfilesForSlot(targetSlot.id).find((profile) => (
          normalizeText(profile.workspace_label).toLowerCase() === normalizeText(importedProfile.workspace_label).toLowerCase()
          && (!matchedProfile || profile.id !== matchedProfile.id)
        )) || null;
        if (duplicateWorkspace) {
          throw new Error('EXCHANGE_DUPLICATE_WORKSPACE');
        }

        if (matchedProfile) {
          updateAuthProfile(matchedProfile.id, buildAuthProfilePatch(importedProfile, matchedProfile));
          keptProfileIds.add(matchedProfile.id);
          if (importedProfile.is_primary) nextPrimaryId = matchedProfile.id;
          result.updated_auth_profiles += 1;
          continue;
        }

        const created = createAuthProfile({
          slot_id: targetSlot.id,
          ...buildAuthProfilePatch(importedProfile, {}),
          is_primary: false,
          is_active: false
        });
        keptProfileIds.add(created.id);
        if (importedProfile.is_primary) nextPrimaryId = created.id;
        result.created_auth_profiles += 1;
      }

      if (strategy === 'replace') {
        existingProfiles
          .filter((profile) => !keptProfileIds.has(profile.id) && !profile.is_active)
          .forEach((profile) => {
            deleteAuthProfile(profile.id);
            result.deleted_auth_profiles += 1;
          });
      }

      const remainingProfiles = listAuthProfilesForSlot(targetSlot.id);
      if (!nextPrimaryId && remainingProfiles.length) {
        nextPrimaryId = (remainingProfiles.find((profile) => profile.is_primary) || remainingProfiles[0]).id;
      }
      if (nextPrimaryId) {
        setPrimaryAuthProfile(targetSlot.id, nextPrimaryId);
        const primary = getPrimaryAuthProfileForSlot(targetSlot.id);
        if (primary) {
          upsertProfile(targetSlot.id, primary.auth_cipher, primary.account_id || null, primary.identity_key || null);
        }
      }
      syncSlotAuthAggregate(targetSlot.id);
    }
  });

  tx();
  return result;
}

module.exports = {
  EXPORT_SCHEMA_VERSION,
  buildExchangeDocument,
  exportExchangeEnvelope,
  importExchangeEnvelope,
  normalizeStrategy,
  parseExchangeEnvelope
};
