const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('path');
const { normalizeRow, renderTemplate } = require('./template');
const {
  buildLinkedinLeads,
  createLinkedinJobManager,
  runLinkedinConnectCampaign
} = require('./linkedinAutomation');
const { runLeadSearchWithEnrichment, createLeadJobManager } = require('./leadFinder');
const { runProjectSearch, createProjectJobManager } = require('./projectFinder');

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
    const fullName = [recipient.first_name, recipient.last_name]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(' ');

    const context = {
      ...recipient,
      name: recipient.name || fullName || recipient.email,
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
        companyName: recipient.company_name || recipient.company || '',
        receiverName: context.name || '',
        email: recipient.email,
        status: 'sent',
        messageId: info.messageId || null
      });
    } catch (error) {
      results.push({
        companyName: recipient.company_name || recipient.company || '',
        receiverName: context.name || '',
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

function buildLinkedinDryRunPreview({ rawRows, connectTemplate, dmTemplate, maxActions }) {
  if (!connectTemplate || !dmTemplate) {
    throw new Error('Both connect note and DM templates are required.');
  }

  const leads = buildLinkedinLeads(rawRows);
  if (!leads.length) {
    throw new Error('No LinkedIn profile URLs found in the uploaded Excel file.');
  }

  const safeMaxActions = Math.min(40, Math.max(1, Number(maxActions || 20)));
  const selected = leads.slice(0, safeMaxActions);
  const inferDryRunAction = (lead, index) => {
    const candidates = [
      lead.dry_run_status,
      lead.connection_status,
      lead.linkedin_status,
      lead.relationship,
      lead.status,
      lead.is_connected,
      lead.pending_request
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);

    const joined = candidates.join(' | ');
    if (/(pending|invited|request sent|already invited)/i.test(joined)) return 'skip_pending';
    if (/(connected|already connected|connection|1st)/i.test(joined)) return 'dm_existing';
    if (/(new|not connected|prospect|connect)/i.test(joined)) return 'connect_new';

    // Deterministic fallback so dry run always shows all three scenarios.
    const cycle = ['connect_new', 'dm_existing', 'skip_pending'];
    return cycle[index % cycle.length];
  };

  const results = selected.map((lead, index) => {
    const renderedConnectMessage = renderTemplate(connectTemplate, lead).trim().slice(0, 300);
    const renderedDmMessage = renderTemplate(dmTemplate, lead).trim().slice(0, 300);
    const action = inferDryRunAction(lead, index);
    let status = 'preview';
    let detail = 'Dry run only. No LinkedIn action was sent.';
    let simulatedAction = '';
    let previewConnectMessage = '';
    let previewDmMessage = '';

    if (action === 'connect_new') {
      status = 'preview_connect';
      simulatedAction = 'new_connection_connect';
      detail = 'Dry run: simulated NEW connection. Connect note template would be used.';
      previewConnectMessage = renderedConnectMessage;
    } else if (action === 'dm_existing') {
      status = 'preview_dm';
      simulatedAction = 'existing_connection_dm';
      detail = 'Dry run: simulated ALREADY CONNECTED. DM template would be sent.';
      previewDmMessage = renderedDmMessage;
    } else {
      status = 'preview_skipped';
      simulatedAction = 'pending_skip';
      detail = 'Dry run: simulated PENDING request. No action would be taken.';
    }

    return {
      timestamp: new Date().toISOString(),
      linkedinUrl: lead.linkedin_url,
      companyName: lead.company_name || '',
      receiverName: lead.receiver_name || '',
      status,
      detail,
      simulatedAction,
      previewConnectMessage,
      previewDmMessage
    };
  });

  const connectPreviewCount = results.filter((r) => r.status === 'preview_connect').length;
  const dmPreviewCount = results.filter((r) => r.status === 'preview_dm').length;
  const skippedPreviewCount = results.filter((r) => r.status === 'preview_skipped').length;

  return {
    totalProfiles: leads.length,
    cappedTo: safeMaxActions,
    previewCount: results.length,
    connectPreviewCount,
    dmPreviewCount,
    skippedPreviewCount,
    results
  };
}

function createApp(deps = {}) {
  const createTransport = deps.createTransport || nodemailer.createTransport;
  const linkedinJobManager = createLinkedinJobManager();
  const leadJobManager = createLeadJobManager();
  const projectJobManager = createProjectJobManager();
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

  app.post('/api/linkedin/start', upload.single('leadsFile'), async (req, res) => {
    try {
      const { connectTemplate, dmTemplate, delayMs, maxActions, freshSession, liAtCookie } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: 'Excel file is required.' });
      }

      if (!connectTemplate || !dmTemplate) {
        return res.status(400).json({ error: 'Both connect note and DM templates are required.' });
      }

      const rawRows = parseWorkbook(req.file.buffer);
      const leads = buildLinkedinLeads(rawRows);
      if (!leads.length) {
        return res.status(400).json({
          error: 'No LinkedIn profile URLs found in the uploaded Excel file.'
        });
      }

      const safeDelayMs = Math.max(5000, Number(delayMs || 12000));
      const safeMaxActions = Math.min(40, Math.max(1, Number(maxActions || 20)));

      const logsDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logsDir, { recursive: true });
      const stamp = Date.now();
      const logFile = path.join(logsDir, `linkedin-${stamp}.jsonl`);
      const debugLogFile = path.join(logsDir, `linkedin-debug-${stamp}.jsonl`);
      const artifactsDir = path.join(logsDir, `linkedin-artifacts-${stamp}`);
      await fs.mkdir(artifactsDir, { recursive: true });

      const job = linkedinJobManager.createJob({
        total: Math.min(leads.length, safeMaxActions),
        logFile,
        debugLogFile,
        artifactsDir
      });

      const sessionDir = path.join(process.cwd(), '.linkedin-session');
      const cookieValue = typeof liAtCookie === 'string' ? liAtCookie.trim() : '';

      // On cloud/Render a browser login window is impossible — reject fast
      const isCloud = !!(process.env.RENDER || process.env.NODE_ENV === 'production');
      if (isCloud && !cookieValue) {
        linkedinJobManager.finishJob(job.id, new Error(
          'li_at session cookie is required on cloud deployments. ' +
          'Fill in Step 4: Chrome → F12 → Application → Cookies → linkedin.com → li_at → copy Value.'
        ));
        return res.json({
          jobId: job.id,
          totalProfiles: leads.length,
          cappedTo: safeMaxActions,
          delayMs: safeDelayMs,
          logFile,
          debugLogFile,
          artifactsDir
        });
      }

      // Only wipe the session if using fresh-session mode AND no cookie provided
      const shouldUseFreshSession = !cookieValue && String(freshSession ?? 'true').toLowerCase() !== 'false';
      if (shouldUseFreshSession && fsSync.existsSync(sessionDir)) {
        await fs.rm(sessionDir, { recursive: true, force: true });
      }

      runLinkedinConnectCampaign({
        leads,
        connectTemplate,
        dmTemplate,
        delayMs: safeDelayMs,
        maxActions: safeMaxActions,
        sessionDir,
        logFile,
        debugLogFile,
        artifactsDir,
        liAtCookie: cookieValue || null,
        onResult: (result) => linkedinJobManager.appendResult(job.id, result)
      })
        .then(() => linkedinJobManager.finishJob(job.id))
        .catch((error) => linkedinJobManager.finishJob(job.id, error));

      return res.json({
        jobId: job.id,
        totalProfiles: leads.length,
        cappedTo: safeMaxActions,
        delayMs: safeDelayMs,
        logFile,
        debugLogFile,
        artifactsDir
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to start LinkedIn job.' });
    }
  });

  app.post('/api/linkedin/dry-run', upload.single('leadsFile'), async (req, res) => {
    try {
      const { connectTemplate, dmTemplate, maxActions } = req.body;
      if (!req.file) {
        return res.status(400).json({ error: 'Excel file is required.' });
      }

      const rawRows = parseWorkbook(req.file.buffer);
      const preview = buildLinkedinDryRunPreview({
        rawRows,
        connectTemplate,
        dmTemplate,
        maxActions
      });
      return res.json(preview);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Failed to build LinkedIn dry run preview.' });
    }
  });

  // ── Lead Finder ─────────────────────────────────────────────────────────────

  app.post('/api/leads/search', async (req, res) => {
    try {
      const {
        keywords, location, companySize, resourceType, industry,
        sources, maxPerSource, enrichContacts
      } = req.body;

      const sourcesArr = Array.isArray(sources) ? sources : ['linkedin', 'indeed', 'web'];
      const safeMax = Math.min(50, Math.max(5, Number(maxPerSource) || 20));
      const shouldEnrich = String(enrichContacts) === 'true';

      const job = leadJobManager.createJob({
        sources: sourcesArr,
        params: { keywords, location, companySize, resourceType, industry }
      });

      const abortController = new AbortController();
      job._abort = () => abortController.abort();

      runLeadSearchWithEnrichment({
        keywords, location, companySize, resourceType, industry,
        sources: sourcesArr, maxPerSource: safeMax, enrichContacts: shouldEnrich,
        signal: abortController.signal,
        onProgress: (phase) => leadJobManager.setPhase(job.id, phase),
        onResult: (lead) => leadJobManager.appendResult(job.id, lead)
      })
        .then(() => leadJobManager.finishJob(job.id))
        .catch((err) => leadJobManager.finishJob(job.id, err));

      return res.json({ jobId: job.id });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to start lead search.' });
    }
  });

  app.post('/api/leads/stop/:jobId', (req, res) => {
    const job = leadJobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (typeof job._abort === 'function') job._abort();
    leadJobManager.finishJob(job.id, new Error('Stopped by user.'));
    return res.json({ ok: true });
  });

  app.get('/api/leads/job/:jobId', (req, res) => {
    const job = leadJobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    // Don't expose internal _abort function
    const { _abort, ...safe } = job;
    void _abort;
    return res.json(safe);
  });

  app.get('/api/leads/export/:jobId', (req, res) => {
    const job = leadJobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    const rows = job.results.map((lead) => ({
      'Company': lead.companyName,
      'Location': lead.location,
      'Company Size': lead.companySize,
      'Industry': lead.industry,
      'Open Roles': (lead.openRoles || []).join(', '),
      'What they need': lead.snippet,
      'Website': lead.companyWebsite,
      'Emails': (lead.emails || []).join(', '),
      'LinkedIn Company': lead.linkedinCompanyUrl,
      'Source': lead.source,
      'Source URL': lead.sourceUrl
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Leads');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="leads-${job.id}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  });

  // ── Project Finder ───────────────────────────────────────────────────────────

  app.post('/api/projects/search', async (req, res) => {
    try {
      const { keywords, location, resourceType, sources, maxPerSource } = req.body;
      const sourcesArr = Array.isArray(sources) ? sources : ['upwork', 'freelancer', 'web'];
      const safeMax = Math.min(30, Math.max(5, Number(maxPerSource) || 10));

      const job = projectJobManager.createJob({
        sources: sourcesArr,
        params: { keywords, location, resourceType }
      });

      const abortController = new AbortController();
      job._abort = () => abortController.abort();

      runProjectSearch({
        keywords, location, resourceType,
        sources: sourcesArr, maxPerSource: safeMax,
        signal: abortController.signal,
        onProgress: (phase) => projectJobManager.setPhase(job.id, phase),
        onResult: (project) => projectJobManager.appendResult(job.id, project)
      })
        .then(() => projectJobManager.finishJob(job.id))
        .catch((err) => projectJobManager.finishJob(job.id, err));

      return res.json({ jobId: job.id });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to start project search.' });
    }
  });

  app.post('/api/projects/stop/:jobId', (req, res) => {
    const job = projectJobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (typeof job._abort === 'function') job._abort();
    projectJobManager.finishJob(job.id, new Error('Stopped by user.'));
    return res.json({ ok: true });
  });

  app.get('/api/projects/job/:jobId', (req, res) => {
    const job = projectJobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const { _abort, ...safe } = job;
    void _abort;
    return res.json(safe);
  });

  app.get('/api/projects/export/:jobId', (req, res) => {
    const job = projectJobManager.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    const rows = job.results.map((p) => ({
      'Title': p.title,
      'Platform': p.platform,
      'Budget': p.budget,
      'Project Type': p.projectType,
      'Skills': (p.skills || []).join(', '),
      'Description': p.description,
      'Posted': p.postedAt,
      'Contact / Poster': p.contactName,
      'Location': p.location,
      'Listing URL': p.listingUrl
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Projects');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="projects-${job.id}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  });

  // ────────────────────────────────────────────────────────────────────────────

  app.get('/api/linkedin/job/:jobId', (req, res) => {
    const job = linkedinJobManager.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    return res.json(job);
  });

  return app;
}

module.exports = {
  createApp,
  parseWorkbook,
  runCampaign,
  buildLinkedinDryRunPreview
};
