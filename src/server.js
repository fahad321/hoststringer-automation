const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const path = require('path');
const { normalizeRow, renderTemplate } = require('./template');

const upload = multer({ storage: multer.memoryStorage() });

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('No worksheet found in uploaded file.');
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) {
    throw new Error('The uploaded worksheet has no data rows.');
  }

  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBoolean(value) {
  return String(value).toLowerCase() === 'true';
}

async function runCampaign({
  rows,
  smtpConfig,
  templates,
  fromName,
  delayMs,
  createTransport
}) {
  const recipients = rows.filter((row) => row.email);
  if (!recipients.length) {
    throw new Error('No valid recipient email addresses were found.');
  }

  const transporter = createTransport({
    host: smtpConfig.hostingerServerUrl,
    port: Number(smtpConfig.smtpPort),
    secure: toBoolean(smtpConfig.smtpSecure),
    auth: {
      user: smtpConfig.hostingerEmail,
      pass: smtpConfig.hostingerPassword
    }
  });

  await transporter.verify();

  const results = [];
  const perEmailDelay = Math.max(0, Number(delayMs || 0));

  for (const recipient of recipients) {
    const context = {
      ...recipient,
      name: recipient.name || recipient.email,
      email: recipient.email
    };

    const mailOptions = {
      from: fromName
        ? `${fromName} <${smtpConfig.hostingerEmail}>`
        : smtpConfig.hostingerEmail,
      to: recipient.email,
      subject: renderTemplate(templates.subjectTemplate, context),
      text: renderTemplate(templates.bodyTemplate, context)
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      results.push({
        email: recipient.email,
        status: 'sent',
        messageId: info.messageId || null
      });
    } catch (error) {
      results.push({
        email: recipient.email,
        status: 'failed',
        error: error.message || 'Unknown send error'
      });
    }

    if (perEmailDelay > 0) {
      await sleep(perEmailDelay);
    }
  }

  const sentCount = results.filter((item) => item.status === 'sent').length;
  const failedCount = results.length - sentCount;

  return {
    totalRecipients: recipients.length,
    sentCount,
    failedCount,
    results
  };
}

function createApp(deps = {}) {
  const createTransport = deps.createTransport || nodemailer.createTransport;
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/preview', upload.single('leadsFile'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Please upload an Excel file (.xlsx).' });
      }

      const rows = parseWorkbook(req.file.buffer);
      const normalized = rows.map(normalizeRow);
      const headers = Object.keys(normalized[0] || {});

      return res.json({
        totalRows: normalized.length,
        headers,
        preview: normalized.slice(0, 5)
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Failed to read the Excel file.' });
    }
  });

  app.post('/api/send-campaign', upload.single('leadsFile'), async (req, res) => {
    try {
      const {
        hostingerServerUrl,
        smtpPort,
        smtpSecure,
        hostingerEmail,
        hostingerPassword,
        fromName,
        subjectTemplate,
        bodyTemplate,
        delayMs
      } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: 'Excel file is required.' });
      }

      if (!hostingerServerUrl || !smtpPort || !hostingerEmail || !hostingerPassword) {
        return res.status(400).json({
          error: 'Hostinger SMTP host, port, email, and password are required.'
        });
      }

      if (!subjectTemplate || !bodyTemplate) {
        return res.status(400).json({ error: 'Email subject and body templates are required.' });
      }

      const rows = parseWorkbook(req.file.buffer).map(normalizeRow);
      const campaignResult = await runCampaign({
        rows,
        smtpConfig: {
          hostingerServerUrl,
          smtpPort,
          smtpSecure,
          hostingerEmail,
          hostingerPassword
        },
        templates: {
          subjectTemplate,
          bodyTemplate
        },
        fromName,
        delayMs,
        createTransport
      });

      return res.json(campaignResult);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Campaign failed.' });
    }
  });

  return app;
}

module.exports = { createApp, parseWorkbook, runCampaign };
