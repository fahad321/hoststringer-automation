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
  return String(template || '').replace(/{{\s*([^{}\s]+)\s*}}/g, (_, token) => {
    const value = context[token];
    return value == null ? '' : String(value);
  });
}

function normalizeRow(rawRow) {
  const row = rawRow || {};
  const normalized = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeKey(key).replace(/\s+/g, '_')] = String(value ?? '').trim();
  }

  const email = findValueByCandidates(row, EMAIL_KEY_CANDIDATES) || normalized.email;
  const name = findValueByCandidates(row, NAME_KEY_CANDIDATES) || normalized.name;

  return {
    ...normalized,
    email,
    name
  };
}

module.exports = {
  normalizeRow,
  renderTemplate
};
