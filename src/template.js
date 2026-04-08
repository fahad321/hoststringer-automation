const EMAIL_KEY_CANDIDATES = [
  'email',
  'e-mail',
  'email address',
  'mail',
  'recipient email'
];

const NAME_KEY_CANDIDATES = ['name', 'full name', 'first name', 'contact name'];

function normalizeKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase();
}

function findValueByCandidates(row, candidates) {
  const entries = Object.entries(row || {});
  for (const [key, value] of entries) {
    if (candidates.includes(normalizeKey(key))) {
      return String(value || '').trim();
    }
  }
  return '';
}

function renderTemplate(template, context) {
  const normalizedKeyMap = {};
  for (const [key, value] of Object.entries(context || {})) {
    const normalizedToken = normalizeKey(key).replace(/[^a-z0-9]/g, '');
    if (normalizedToken && normalizedKeyMap[normalizedToken] == null) {
      normalizedKeyMap[normalizedToken] = value;
    }
  }

  const replaceToken = (_, token) => {
    const directValue = context ? context[token] : undefined;
    if (directValue != null) {
      return String(directValue);
    }

    const normalizedToken = normalizeKey(token).replace(/[^a-z0-9]/g, '');
    const value = normalizedKeyMap[normalizedToken];
    return value == null ? '' : String(value);
  };

  return String(template || '')
    .replace(/{{\s*([^{}\s]+)\s*}}/g, replaceToken)
    .replace(/\{([a-zA-Z0-9_]+)\}/g, replaceToken);
}

function normalizeRow(rawRow) {
  const row = rawRow || {};
  const normalized = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeKey(key).replace(/\s+/g, '_')] = String(value ?? '').trim();
  }

  const email = findValueByCandidates(row, EMAIL_KEY_CANDIDATES) || normalized.email;
  const name = findValueByCandidates(row, NAME_KEY_CANDIDATES) || normalized.name;
  const companyName = normalized.company_name || normalized.company || '';
  const industryName = normalized.industry_name || normalized.industry || '';

  return {
    ...normalized,
    email,
    name,
    company_name: companyName,
    industry_name: industryName
  };
}

module.exports = {
  normalizeRow,
  renderTemplate
};
