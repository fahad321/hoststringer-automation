const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRow, renderTemplate } = require('../src/template');

test('renderTemplate replaces placeholders with recipient data', () => {
  const output = renderTemplate('Hello {{name}} at {{company}}', {
    name: 'Sara',
    company: 'Acme'
  });

  assert.equal(output, 'Hello Sara at Acme');
});

test('normalizeRow maps common name/email headers', () => {
  const row = normalizeRow({
    'Full Name': 'John Doe',
    'Email Address': 'john@example.com',
    Company: 'Example Inc'
  });

  assert.equal(row.name, 'John Doe');
  assert.equal(row.email, 'john@example.com');
  assert.equal(row.company, 'Example Inc');
});
