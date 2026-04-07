function pickPrimary(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find((x) => x && x.primary === true) || list[0] || null;
}

function firstNameFromFullName(fullName) {
  const s = String(fullName || '').trim();
  if (!s) return 'there';
  return s.split(/\s+/)[0] || 'there';
}

function normalizeConsentStatus(status) {
  if (status === null || status === undefined) return null;
  const s = String(status).trim();
  if (!s) return null;
  return s.toUpperCase();
}

function parseOptInAllowlist(csv, fallback) {
  const raw = String(csv || '').trim();
  const values = raw
    ? raw.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean)
    : fallback;
  return new Set(values);
}

function isStrictOptIn(status, allowlist) {
  const s = normalizeConsentStatus(status);
  if (!s) return false;
  return allowlist.has(s);
}

/**
 * Compute strict, compliance-safe eligibility. Only explicit OPT_IN values
 * are treated as eligible; everything else is ineligible by default.
 */
function computeEligibility({ phone, email, smsAllowedFlag, smsConsentStatus, emailConsentStatus, optedOut }) {
  const smsOptIn = parseOptInAllowlist(process.env.SMS_OPT_IN_VALUES, ['OPT_IN', 'OPTED_IN']);
  const emailOptIn = parseOptInAllowlist(process.env.EMAIL_OPT_IN_VALUES, ['OPT_IN', 'OPTED_IN']);

  const hasPhone = !!String(phone || '').trim();
  const hasEmail = !!String(email || '').trim();

  const smsAllowed = smsAllowedFlag === true;

  const smsOk =
    !optedOut &&
    hasPhone &&
    smsAllowed &&
    isStrictOptIn(smsConsentStatus, smsOptIn);

  const emailOk =
    hasEmail &&
    isStrictOptIn(emailConsentStatus, emailOptIn);

  return { isSmsEligible: smsOk, isEmailEligible: emailOk };
}

module.exports = {
  pickPrimary,
  firstNameFromFullName,
  normalizeConsentStatus,
  computeEligibility,
};
