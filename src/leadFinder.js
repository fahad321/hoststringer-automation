'use strict';
// Ensure Playwright finds browsers inside node_modules (works on Render/cloud)
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = require('playwright');

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractEmails(text) {
  const raw = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(raw)].filter((e) => {
    const l = e.toLowerCase();
    return !l.match(/\.(png|jpg|gif|svg|css|js|webp)$/) &&
      !l.includes('sentry.io') && !l.includes('example.') &&
      !l.includes('@2x') && !l.includes('wixpress') &&
      !/^(no-?reply|support|admin|info|hello|contact)@.{1,4}\./.test(l);
  });
}

function extractLinkedInCompanyUrl(html) {
  const m = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9\-_.%]+/i);
  return m ? m[0].split('?')[0] : '';
}

function cleanOrigin(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return `${u.protocol}//${u.hostname}`;
  } catch { return ''; }
}

function normalizeKey(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(pty|ltd|inc|llc|corp|limited|incorporated|co|company|group|holdings?|solutions?|technologies|services|consulting)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeLeadId() {
  return `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Browser launch ───────────────────────────────────────────────────────────

async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    throw new Error(
      `Lead Finder could not launch a browser: ${err.message}. ` +
      'Run "npx playwright install chromium" to install the bundled browser.'
    );
  }
}

// ─── LinkedIn Jobs ────────────────────────────────────────────────────────────

async function scrapeLinkedInJobs(page, { keywords, location, maxResults }) {
  const leads = [];
  try {
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location || '')}&f_TPR=r2592000&sortBy=R`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    // Dismiss login/cookie modals without navigating away
    for (const sel of [
      'button[aria-label*="Dismiss"]',
      'button.modal__dismiss',
      'button[data-tracking-control-name*="dismiss"]'
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.count()) await btn.click({ timeout: 2000 }).catch(() => null);
    }

    await page.waitForTimeout(800);

    const jobs = await page.evaluate(() => {
      const out = [];
      const cards = document.querySelectorAll(
        '.base-card, .job-search-card, li.jobs-search__results-list__item'
      );
      for (const c of Array.from(cards).slice(0, 60)) {
        const title = (
          c.querySelector('h3.base-search-card__title, .job-card-list__title')?.textContent || ''
        ).trim();
        const company = (
          c.querySelector('h4.base-search-card__subtitle, .base-search-card__subtitle, .job-card-container__company-name')?.textContent || ''
        ).trim();
        const loc = (
          c.querySelector('.job-search-card__location, .base-search-card__metadata')?.textContent || ''
        ).trim();
        const href = c.querySelector('a[href*="/jobs/view/"]')?.href || '';
        if (company && title) out.push({ title, company, loc, href });
      }
      return out;
    });

    const seen = new Set();
    for (const j of jobs) {
      const key = normalizeKey(j.company);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leads.push({
        id: makeLeadId(),
        companyName: j.company,
        location: j.loc,
        openRoles: [j.title],
        source: 'LinkedIn Jobs',
        sourceUrl: j.href,
        companyWebsite: '',
        companySize: 'unknown',
        industry: '',
        emails: [],
        linkedinCompanyUrl: '',
        snippet: `Actively hiring: ${j.title}`
      });
      if (leads.length >= maxResults) break;
    }
  } catch (_) { /* source unavailable */ }
  return leads;
}

// ─── Indeed Jobs ─────────────────────────────────────────────────────────────

async function scrapeIndeedJobs(page, { keywords, location, maxResults }) {
  const leads = [];
  try {
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(keywords)}&l=${encodeURIComponent(location || '')}&sort=date`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('[data-jk], .job_seen_beacon')).slice(0, 40)) {
        const title = (card.querySelector('.jobTitle span[title], .jobTitle span, h2.jobTitle span')?.textContent || '').trim();
        const company = (card.querySelector('.companyName, [data-testid="company-name"]')?.textContent || '').trim();
        const loc = (card.querySelector('.companyLocation, [data-testid="text-location"]')?.textContent || '').trim();
        const snippet = (card.querySelector('.job-snippet, .underShelfFooter .result-link-bar-container')?.textContent || '').trim().slice(0, 180);
        const href = card.querySelector('.jobTitle a, h2.jobTitle a')?.href || '';
        if (company && title) out.push({ title, company, loc, snippet, href });
      }
      return out;
    });

    const seen = new Set();
    for (const j of jobs) {
      const key = normalizeKey(j.company);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leads.push({
        id: makeLeadId(),
        companyName: j.company,
        location: j.loc,
        openRoles: [j.title],
        source: 'Indeed',
        sourceUrl: j.href,
        companyWebsite: '',
        companySize: 'unknown',
        industry: '',
        emails: [],
        linkedinCompanyUrl: '',
        snippet: j.snippet || `Hiring: ${j.title}`
      });
      if (leads.length >= maxResults) break;
    }
  } catch (_) { /* source unavailable */ }
  return leads;
}

// ─── Seek (AU) ────────────────────────────────────────────────────────────────

async function scrapeSeekJobs(page, { keywords, location, maxResults }) {
  const leads = [];
  try {
    const url = `https://www.seek.com.au/jobs?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location || '')}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('[data-testid="job-card"], article[data-card-type="JobCard"]')).slice(0, 40)) {
        const title = (card.querySelector('[data-automation="jobTitle"], h3')?.textContent || '').trim();
        const company = (card.querySelector('[data-automation="advertiser-name"]')?.textContent || '').trim();
        const loc = (card.querySelector('[data-automation="job-location"]')?.textContent || '').trim();
        const href = card.querySelector('a[href*="/job/"]')?.href || '';
        if (company && title) out.push({ title, company, loc, href });
      }
      return out;
    });

    const seen = new Set();
    for (const j of jobs) {
      const key = normalizeKey(j.company);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leads.push({
        id: makeLeadId(),
        companyName: j.company,
        location: j.loc,
        openRoles: [j.title],
        source: 'Seek',
        sourceUrl: j.href,
        companyWebsite: '',
        companySize: 'unknown',
        industry: '',
        emails: [],
        linkedinCompanyUrl: '',
        snippet: `Hiring: ${j.title}`
      });
      if (leads.length >= maxResults) break;
    }
  } catch (_) { /* source unavailable */ }
  return leads;
}

// ─── Web search (DuckDuckGo) ──────────────────────────────────────────────────

async function searchWeb(page, query, maxResults) {
  const leads = [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1200);

    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.result, .web-result')).slice(0, 20).map((div) => {
        const titleEl = div.querySelector('.result__title a, h2 a');
        const snippetEl = div.querySelector('.result__snippet');
        return {
          title: (titleEl?.textContent || '').trim(),
          href: titleEl?.href || '',
          snippet: (snippetEl?.textContent || '').trim().slice(0, 200)
        };
      }).filter((r) => r.title && r.href && !r.href.includes('duckduckgo'));
    });

    for (const r of results) {
      // Title format "Job Title - Company Name" or "Company | Tagline"
      const parts = r.title.split(/\s*[-–|]\s*/);
      const companyName = parts.length > 1 ? parts[parts.length - 1].trim() : '';
      if (!companyName || companyName.length > 80) continue;

      const website = cleanOrigin(r.href);
      if (!website) continue;

      leads.push({
        id: makeLeadId(),
        companyName,
        location: '',
        openRoles: [parts[0]?.trim() || r.title],
        source: 'Web Search',
        sourceUrl: r.href,
        companyWebsite: website,
        companySize: 'unknown',
        industry: '',
        emails: [],
        linkedinCompanyUrl: '',
        snippet: r.snippet
      });
      if (leads.length >= maxResults) break;
    }
  } catch (_) { /* source unavailable */ }
  return leads;
}

// ─── Contact enrichment ───────────────────────────────────────────────────────

async function enrichLeadContact(page, lead) {
  if (!lead.companyWebsite) return lead;
  try {
    await page.goto(lead.companyWebsite, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await sleep(700);

    const { emails, linkedinUrl, contactPageHref } = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const html = document.body.innerHTML || '';
      const emails = (text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []);
      const linkedinUrl = (html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9\-_.%]+/i) || [])[0] || '';
      const contactHref = Array.from(document.querySelectorAll('a[href]'))
        .find((a) => /^(contact|about|team|reach|get.in.touch)/i.test((a.textContent || '').trim()))
        ?.href || '';
      return { emails, linkedinUrl, contactPageHref: contactHref };
    });

    lead.emails = extractEmails(emails.join(' '));
    if (linkedinUrl) lead.linkedinCompanyUrl = linkedinUrl;

    // Try contact page if no email yet
    if (!lead.emails.length && contactPageHref && contactPageHref.startsWith('http')) {
      try {
        await page.goto(contactPageHref, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await sleep(500);
        const moreText = await page.evaluate(() => document.body.innerText || '');
        lead.emails = extractEmails(moreText);
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* enrichment failed */ }
  return lead;
}

// ─── Google company website finder ────────────────────────────────────────────
// When a lead has no website, try to find it via DuckDuckGo

async function findCompanyWebsite(page, companyName) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${companyName} official website`)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(800);
    const href = await page.evaluate(() => {
      const link = document.querySelector('.result__title a, .web-result .result__title a');
      return link?.href || '';
    });
    return cleanOrigin(href);
  } catch (_) { return ''; }
}

// ─── Main search orchestrator ─────────────────────────────────────────────────

async function runLeadSearch({
  keywords,
  location,
  companySize,
  resourceType,
  industry,
  sources,
  maxPerSource,
  enrichContacts,
  onProgress,
  onResult,
  signal
}) {
  const isCancelled = () => signal?.aborted === true;

  // Build enriched keyword string
  const resourceMap = {
    developers: 'software developer OR web developer OR full stack',
    devops: 'DevOps OR cloud engineer OR infrastructure',
    data: 'data engineer OR data scientist OR analytics',
    design: 'UX designer OR product designer',
    architecture: 'solution architect OR enterprise architect',
    any: 'software developer OR IT staff OR technology'
  };
  const resourceStr = resourceMap[resourceType] || resourceMap.any;
  const industryStr = industry && industry !== 'any' ? ` ${industry}` : '';
  const sizeStr = companySize === 'smb' ? ' startup OR "SME" OR "small business"'
    : companySize === 'enterprise' ? ' enterprise OR corporation' : '';

  const searchKeywords = keywords || `${resourceStr} hiring${industryStr}${sizeStr}`;
  const webQuery = `IT staff augmentation ${location || ''} ${industryStr} ${sizeStr} hiring`.trim();

  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  // Global dedup across all sources
  const seenKeys = new Set();

  async function emitLeads(rawLeads) {
    for (const lead of rawLeads) {
      if (isCancelled()) break;
      const key = normalizeKey(lead.companyName);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      onResult(lead);
    }
  }

  try {
    const page = await context.newPage();

    // ── Source: LinkedIn Jobs ────────────────────────────────
    if (sources.includes('linkedin') && !isCancelled()) {
      onProgress('Searching LinkedIn Jobs…');
      const results = await scrapeLinkedInJobs(page, {
        keywords: searchKeywords,
        location,
        maxResults: maxPerSource
      });
      await emitLeads(results);
    }

    // ── Source: Indeed ───────────────────────────────────────
    if (sources.includes('indeed') && !isCancelled()) {
      onProgress('Searching Indeed…');
      const results = await scrapeIndeedJobs(page, {
        keywords: searchKeywords,
        location,
        maxResults: maxPerSource
      });
      await emitLeads(results);
    }

    // ── Source: Seek ─────────────────────────────────────────
    if (sources.includes('seek') && !isCancelled()) {
      onProgress('Searching Seek…');
      const results = await scrapeSeekJobs(page, {
        keywords: searchKeywords,
        location,
        maxResults: maxPerSource
      });
      await emitLeads(results);
    }

    // ── Source: Web Search ───────────────────────────────────
    if (sources.includes('web') && !isCancelled()) {
      onProgress('Running broad web search…');
      const results = await searchWeb(page, webQuery, maxPerSource);
      await emitLeads(results);
    }

    // ── Contact enrichment ───────────────────────────────────
    if (enrichContacts && !isCancelled()) {
      onProgress('Enriching contact details — visiting company websites…');
      // We can't mutate already-emitted results, so enrichment updates come through onResult again
      // The job manager merges by lead id
      const snapshot = [...seenKeys]; // just to know how many we have
      let count = 0;
      // Re-create a list of leads to enrich from the job results
      // (the job manager holds them; we'll enrich via the callback mechanism)
      // Since we don't have them here, enrichment runs during emission above in a second pass
      // For simplicity: emit enriched versions after initial emission
      // (The job manager on the server side handles merging by id)
      void snapshot; void count;
    }

  } finally {
    await browser.close().catch(() => null);
  }
}

// Version with enrichment interleaved during scraping
async function runLeadSearchWithEnrichment(params) {
  const {
    keywords, location, companySize, resourceType, industry,
    sources, maxPerSource, enrichContacts, onProgress, onResult, signal
  } = params;

  const isCancelled = () => signal?.aborted === true;

  const resourceMap = {
    developers: 'software developer OR web developer OR full stack developer',
    devops: 'DevOps engineer OR cloud engineer',
    data: 'data engineer OR data scientist',
    design: 'UX designer OR UI designer',
    architecture: 'solution architect OR enterprise architect',
    any: 'software developer OR IT consultant OR technology staff'
  };
  const resourceStr = resourceMap[resourceType] || resourceMap.any;
  const industryStr = industry && industry !== 'any' ? ` ${industry}` : '';
  const sizeHint = companySize === 'smb' ? ' startup OR SME OR "small business"'
    : companySize === 'enterprise' ? ' enterprise OR corporation' : '';

  const searchKeywords = keywords || `${resourceStr} hiring${industryStr}${sizeHint}`;
  const webQuery = `"IT staff augmentation" OR "digital transformation" hiring ${location || ''}${industryStr}${sizeHint}`.trim();

  const browser = await launchBrowser();
  const mainContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const seenKeys = new Set();

  async function processLeads(rawLeads, page) {
    for (const lead of rawLeads) {
      if (isCancelled()) break;
      const key = normalizeKey(lead.companyName);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);

      let enriched = { ...lead };

      if (enrichContacts) {
        // Find website if missing
        if (!enriched.companyWebsite) {
          enriched.companyWebsite = await findCompanyWebsite(page, enriched.companyName);
        }
        // Scrape contact details
        if (enriched.companyWebsite) {
          enriched = await enrichLeadContact(page, enriched);
        }
      }

      onResult(enriched);
    }
  }

  try {
    const page = await mainContext.newPage();

    if (sources.includes('linkedin') && !isCancelled()) {
      onProgress('Searching LinkedIn Jobs…');
      const results = await scrapeLinkedInJobs(page, { keywords: searchKeywords, location, maxResults: maxPerSource });
      await processLeads(results, page);
    }

    if (sources.includes('indeed') && !isCancelled()) {
      onProgress('Searching Indeed…');
      const results = await scrapeIndeedJobs(page, { keywords: searchKeywords, location, maxResults: maxPerSource });
      await processLeads(results, page);
    }

    if (sources.includes('seek') && !isCancelled()) {
      onProgress('Searching Seek…');
      const results = await scrapeSeekJobs(page, { keywords: searchKeywords, location, maxResults: maxPerSource });
      await processLeads(results, page);
    }

    if (sources.includes('web') && !isCancelled()) {
      onProgress('Running broad web search…');
      const results = await searchWeb(page, webQuery, maxPerSource);
      await processLeads(results, page);
    }

  } finally {
    await browser.close().catch(() => null);
  }
}

// ─── Job manager ─────────────────────────────────────────────────────────────

function createLeadJobManager() {
  const jobs = new Map();

  function createJob({ sources, params }) {
    const id = `leadjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      status: 'running',
      phase: 'starting',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      found: 0,
      withEmail: 0,
      withLinkedIn: 0,
      results: [],
      error: null,
      sources,
      params
    };
    jobs.set(id, job);
    return job;
  }

  function getJob(id) { return jobs.get(id) || null; }

  function setPhase(id, phase) {
    const job = jobs.get(id);
    if (job) job.phase = phase;
  }

  function appendResult(id, lead) {
    const job = jobs.get(id);
    if (!job) return;
    job.results.push(lead);
    job.found = job.results.length;
    job.withEmail = job.results.filter((r) => r.emails && r.emails.length > 0).length;
    job.withLinkedIn = job.results.filter((r) => r.linkedinCompanyUrl).length;
  }

  function finishJob(id, error) {
    const job = jobs.get(id);
    if (!job) return;
    job.status = error ? 'failed' : 'completed';
    job.phase = error ? 'failed' : 'done';
    job.error = error ? String(error.message || error) : null;
    job.finishedAt = new Date().toISOString();
  }

  return { createJob, getJob, setPhase, appendResult, finishJob };
}

module.exports = { runLeadSearchWithEnrichment, createLeadJobManager };
