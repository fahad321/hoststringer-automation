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

test('renderTemplate supports firstname/lastname/companyname token variations', () => {
  const output = renderTemplate(
    'Hi {{firstname}} {{last_name}} from {{companyname}}',
    {
      first_name: 'Ava',
      last_name: 'Lee',
      company_name: 'Axivio Consultancy'
    }
  );

  assert.equal(output, 'Hi Ava Lee from Axivio Consultancy');
});

test('renderTemplate supports single-brace token style', () => {
  const output = renderTemplate(
    'Hi {first_name}, welcome to {company_name}.',
    { first_name: 'Jono', company_name: 'Axivio' }
  );

  assert.equal(output, 'Hi Jono, welcome to Axivio.');
});

test('normalizeRow maps company_name and industry_name aliases', () => {
  const row = normalizeRow({
    Company: 'ABC Pty',
    Industry: 'Retail'
  });

  assert.equal(row.company_name, 'ABC Pty');
  assert.equal(row.industry_name, 'Retail');
});
