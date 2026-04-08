const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseWorkbook, runCampaign, buildLinkedinDryRunPreview } = require('../src/server');

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
      { name: 'Ok User', email: 'ok@example.com', company_name: 'Alpha Pty' },
      { name: 'Fail User', email: 'fail@example.com', company_name: 'Beta Pty' }
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
  assert.equal(result.results[0].companyName, 'Alpha Pty');
  assert.equal(result.results[0].receiverName, 'Ok User');
});

test('buildLinkedinDryRunPreview renders template message for linkedin leads', async () => {
  const preview = buildLinkedinDryRunPreview({
    rawRows: [
      {
        'First Name': 'Aqsa',
        'Last Name': 'Akber',
        'Company Name': 'ABC',
        'Person Linkedin Url': 'https://www.linkedin.com/in/aqsa-akber-5bba83119/'
      }
    ],
    connectTemplate: 'Connect: Hi {{first_name}} {{last_name}} from {{company_name}}',
    dmTemplate: 'DM: Hi {{first_name}}, sharing this with {{company_name}}',
    maxActions: 10
  });

  assert.equal(preview.totalProfiles, 1);
  assert.equal(preview.previewCount, 1);
  assert.equal(preview.results[0].status, 'preview_connect');
  assert.equal(preview.results[0].companyName, 'ABC');
  assert.equal(preview.results[0].receiverName, 'Aqsa Akber');
  assert.equal(preview.results[0].previewConnectMessage, 'Connect: Hi Aqsa Akber from ABC');
  assert.equal(preview.results[0].previewDmMessage, '');
});

test('buildLinkedinDryRunPreview classifies connection states from excel status', async () => {
  const preview = buildLinkedinDryRunPreview({
    rawRows: [
      {
        'First Name': 'New',
        'Last Name': 'Lead',
        'Company Name': 'C1',
        'Person Linkedin Url': 'https://www.linkedin.com/in/new-lead/',
        'Connection Status': 'new'
      },
      {
        'First Name': 'Old',
        'Last Name': 'Friend',
        'Company Name': 'C2',
        'Person Linkedin Url': 'https://www.linkedin.com/in/old-friend/',
        'Connection Status': 'already connected'
      },
      {
        'First Name': 'Wait',
        'Last Name': 'Pending',
        'Company Name': 'C3',
        'Person Linkedin Url': 'https://www.linkedin.com/in/wait-pending/',
        'Connection Status': 'pending'
      }
    ],
    connectTemplate: 'Connect {{first_name}}',
    dmTemplate: 'DM {{first_name}}',
    maxActions: 10
  });

  assert.equal(preview.connectPreviewCount, 1);
  assert.equal(preview.dmPreviewCount, 1);
  assert.equal(preview.skippedPreviewCount, 1);
  assert.equal(preview.results[0].status, 'preview_connect');
  assert.equal(preview.results[0].previewConnectMessage, 'Connect New');
  assert.equal(preview.results[1].status, 'preview_dm');
  assert.equal(preview.results[1].previewDmMessage, 'DM Old');
  assert.equal(preview.results[2].status, 'preview_skipped');
  assert.equal(preview.results[2].previewConnectMessage, '');
  assert.equal(preview.results[2].previewDmMessage, '');
});
