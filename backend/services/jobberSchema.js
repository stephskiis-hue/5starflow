const { jobberGraphQL } = require('./jobberClient');

const TYPE_FIELDS = `
  query TypeFields($name: String!) {
    __type(name: $name) {
      name
      fields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
`;

function unwrapTypeName(typeNode) {
  let t = typeNode;
  while (t) {
    if (t.name) return t.name;
    t = t.ofType;
  }
  return null;
}

function findFieldCaseInsensitive(fields, candidates) {
  const byLower = new Map();
  for (const f of fields || []) {
    if (f?.name) byLower.set(String(f.name).toLowerCase(), f.name);
  }
  for (const c of candidates) {
    const hit = byLower.get(String(c).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function getTypeFields(typeName, userId) {
  const data = await jobberGraphQL(TYPE_FIELDS, { name: typeName }, userId);
  return data?.__type?.fields || [];
}

/**
 * Discover where marketing consent fields live in the current Jobber schema.
 *
 * Returns:
 *  {
 *    sms:   { on: 'client'|'phone', field: string|null },
 *    email: { on: 'client'|'email', field: string|null },
 *    phoneType: string|null,
 *    emailType: string|null
 *  }
 *
 * Overrides:
 *  - JOBBER_SMS_CONSENT_FIELD / JOBBER_SMS_CONSENT_ON
 *  - JOBBER_EMAIL_CONSENT_FIELD / JOBBER_EMAIL_CONSENT_ON
 */
async function discoverMarketingConsentFields(userId) {
  const overrideSmsField = process.env.JOBBER_SMS_CONSENT_FIELD || null;
  const overrideSmsOn    = (process.env.JOBBER_SMS_CONSENT_ON || '').toLowerCase(); // client|phone
  const overrideEmailField = process.env.JOBBER_EMAIL_CONSENT_FIELD || null;
  const overrideEmailOn    = (process.env.JOBBER_EMAIL_CONSENT_ON || '').toLowerCase(); // client|email

  const clientFields = await getTypeFields('Client', userId);

  const clientFieldNames = (clientFields || []).map((f) => f.name).filter(Boolean);

  // Preferred candidates (spec) + a few common alternates
  const smsCandidates = [
    'textMessageMarketingConsent',
    'smsMarketingConsent',
    'textMessageConsent',
  ];
  const emailCandidates = [
    'emailMarketingConsent',
    'emailConsent',
    'emailNewsletterConsent',
  ];

  const phonesField = (clientFields || []).find((f) => f.name === 'phones') || null;
  const emailsField = (clientFields || []).find((f) => f.name === 'emails') || null;
  const phoneType = phonesField ? unwrapTypeName(phonesField.type) : null;
  const emailType = emailsField ? unwrapTypeName(emailsField.type) : null;

  const smsClientField = findFieldCaseInsensitive(clientFieldNames, smsCandidates);
  const emailClientField = findFieldCaseInsensitive(clientFieldNames, emailCandidates);

  // If missing at client level, look on phone/email types (if we can identify them).
  let smsPhoneField = null;
  if (!smsClientField && phoneType) {
    const phoneFields = await getTypeFields(phoneType, userId);
    const phoneFieldNames = (phoneFields || []).map((f) => f.name).filter(Boolean);
    smsPhoneField = findFieldCaseInsensitive(phoneFieldNames, smsCandidates);
  }

  let emailEmailField = null;
  if (!emailClientField && emailType) {
    const emFields = await getTypeFields(emailType, userId);
    const emFieldNames = (emFields || []).map((f) => f.name).filter(Boolean);
    emailEmailField = findFieldCaseInsensitive(emFieldNames, emailCandidates);
  }

  const sms =
    overrideSmsField
      ? { on: overrideSmsOn === 'phone' ? 'phone' : 'client', field: overrideSmsField }
      : smsClientField
      ? { on: 'client', field: smsClientField }
      : smsPhoneField
      ? { on: 'phone', field: smsPhoneField }
      : { on: 'client', field: null };

  const email =
    overrideEmailField
      ? { on: overrideEmailOn === 'email' ? 'email' : 'client', field: overrideEmailField }
      : emailClientField
      ? { on: 'client', field: emailClientField }
      : emailEmailField
      ? { on: 'email', field: emailEmailField }
      : { on: 'client', field: null };

  return { sms, email, phoneType, emailType };
}

module.exports = {
  discoverMarketingConsentFields,
  unwrapTypeName,
};

