const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseWorkbook, runCampaign } = require('../src/server');

function buildWorkbookBuffer(rows) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Leads');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

test('parseWorkbook returns rows from first worksheet', async () => {
  const workbookBuffer = buildWorkbookBuffer([
    { Name: 'Ava', Email: 'ava@example.com', Company: 'Bright Co' }
  ]);
  const rows = parseWorkbook(workbookBuffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Email, 'ava@example.com');
});

test('runCampaign sends recipients sequentially and reports failures', async () => {
  const sentTo = [];
  const result = await runCampaign({
    rows: [
      { name: 'Ok User', email: 'ok@example.com' },
      { name: 'Fail User', email: 'fail@example.com' }
    ],
    smtpConfig: {
      hostingerServerUrl: 'smtp.hostinger.com',
      smtpPort: '465',
      smtpSecure: 'true',
      hostingerEmail: 'sender@example.com',
      hostingerPassword: 'secret'
    },
    templates: {
      subjectTemplate: 'Hello {{name}}',
      bodyTemplate: 'Hi {{name}}'
    },
    fromName: 'Sender',
    delayMs: 0,
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (mail) => {
        sentTo.push(mail.to);
        if (mail.to === 'fail@example.com') {
          throw new Error('Delivery failed');
        }
        return { messageId: `id-${mail.to}` };
      }
    })
  });

  assert.deepEqual(sentTo, ['ok@example.com', 'fail@example.com']);
  assert.equal(result.sentCount, 1);
  assert.equal(result.failedCount, 1);
});
