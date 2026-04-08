'use strict';
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProjId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function extractBudget(text) {
  const m = text.match(/\$[\d,]+(?:\s*[-–k]+\s*\$?[\d,k]+)?(?:\s*\/\s*(?:hr|hour|month|mo))?/i);
  return m ? m[0] : '';
}

function extractSkills(text) {
  const known = [
    'React','Angular','Vue','Node.js','Python','Java','PHP','Laravel','Django',
    '.NET','C#','C++','AWS','Azure','GCP','DevOps','Docker','Kubernetes','Terraform',
    'PostgreSQL','MySQL','MongoDB','TypeScript','JavaScript','Swift','Kotlin',
    'Flutter','React Native','iOS','Android','Salesforce','SAP','ServiceNow',
    'Magento','Shopify','WordPress','AI','ML','Machine Learning','Data Science',
    'Blockchain','Cybersecurity','QA','Automation','UX','UI','Figma','Scrum',
    'Agile','CI/CD','REST','GraphQL','Microservices','Next.js','Nest.js','Ruby'
  ];
  const lower = text.toLowerCase();
  return known.filter((s) => lower.includes(s.toLowerCase())).slice(0, 8);
}

function stripPlatformSuffix(title) {
  return title
    .replace(/\s*[-–|]\s*(Upwork|Freelancer|PeoplePerHour|Guru|Toptal|Fiverr|LinkedIn).*/i, '')
    .replace(/\s*\|\s*.+$/, '')
    .trim();
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    throw new Error(
      `Project Finder could not launch a browser: ${err.message}. ` +
      'Run "npx playwright install chromium" to install the bundled browser.'
    );
  }
}

// ─── DuckDuckGo HTML search ───────────────────────────────────────────────────

async function searchDDG(page, query, maxResults = 15) {
  const results = [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1200);
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.result, .web-result')).slice(0, 25).map((div) => {
        const titleEl = div.querySelector('.result__title a, h2 a');
        const snippetEl = div.querySelector('.result__snippet');
        return {
          title: (titleEl?.textContent || '').trim(),
          url: titleEl?.href || '',
          snippet: (snippetEl?.textContent || '').trim().slice(0, 320)
        };
      }).filter((r) => r.title && r.url && !r.url.includes('duckduckgo'))
    );
    for (const r of raw) {
      if (results.length >= maxResults) break;
      results.push(r);
    }
  } catch (_) { /* source unavailable */ }
  return results;
}

// ─── Upwork ───────────────────────────────────────────────────────────────────

async function searchUpwork(page, { keywords, location, maxResults }) {
  const projects = [];

  // Try direct public search first
  try {
    const url = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(keywords)}&sort=recency`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(
        document.querySelectorAll('[data-test="job-tile"], .job-tile, section[data-job-uid]')
      ).slice(0, 30)) {
        const titleEl = card.querySelector('h2 a, h3 a, [data-test="job-title"], a[class*="title"]');
        const title = (titleEl?.textContent || '').trim();
        const href = titleEl?.href || '';
        const snippet = (card.querySelector('[data-test="job-description-text"], [class*="description"]')?.textContent || '').trim().slice(0, 280);
        const budget = (card.querySelector('[data-test="budget"], [class*="budget"], [class*="hourly-rate"]')?.textContent || '').trim();
        const skills = Array.from(card.querySelectorAll('[data-test="token"], [class*="skill"], [class*="tag"]'))
          .map((s) => s.textContent.trim()).filter(Boolean).slice(0, 8);
        const posted = (card.querySelector('[data-test="posted-on"] span, time')?.textContent || '').trim();
        const client = (card.querySelector('[data-test="client-country"], [class*="client"]')?.textContent || '').trim();
        if (title && href) out.push({ title, href, snippet, budget, skills, posted, client });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      projects.push({
        id: makeProjId(),
        title: j.title,
        description: j.snippet,
        platform: 'Upwork',
        budget: j.budget || extractBudget(j.snippet),
        skills: j.skills.length ? j.skills : extractSkills(j.snippet),
        postedAt: j.posted,
        listingUrl: j.href.startsWith('http') ? j.href : `https://www.upwork.com${j.href}`,
        contactName: j.client || '',
        location: location || '',
        projectType: (j.budget || '').toLowerCase().includes('/hr') ? 'hourly' : 'fixed',
        source: 'upwork'
      });
    }
  } catch (_) { /* fall through to DDG */ }

  // Fallback: DuckDuckGo site search
  if (!projects.length) {
    const q = `site:upwork.com/jobs ${keywords}${location ? ` ${location}` : ''}`;
    const results = await searchDDG(page, q, maxResults);
    for (const r of results) {
      if (!r.url.match(/upwork\.com\/(jobs|freelance-jobs|o\/jobs)/)) continue;
      projects.push({
        id: makeProjId(),
        title: stripPlatformSuffix(r.title),
        description: r.snippet,
        platform: 'Upwork',
        budget: extractBudget(r.title + ' ' + r.snippet),
        skills: extractSkills(r.snippet),
        postedAt: '',
        listingUrl: r.url,
        contactName: '',
        location: location || '',
        projectType: 'fixed',
        source: 'upwork'
      });
    }
  }

  return projects;
}

// ─── Freelancer ───────────────────────────────────────────────────────────────

async function searchFreelancer(page, { keywords, location, maxResults }) {
  const projects = [];

  // Try direct scraping
  try {
    const url = `https://www.freelancer.com/jobs/${encodeURIComponent(keywords.toLowerCase().replace(/\s+/g, '-'))}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.JobSearchCard-item, [class*="JobSearchCard"]')).slice(0, 30)) {
        const titleEl = card.querySelector('a.JobSearchCard-primary-heading-link, h2 a, a[href*="/projects/"]');
        const title = (titleEl?.textContent || '').trim();
        const href = titleEl?.href || '';
        const snippet = (card.querySelector('[class*="description"], p')?.textContent || '').trim().slice(0, 280);
        const budget = (card.querySelector('[class*="JobSearchCard-primary-price"]')?.textContent || '').trim();
        const skills = Array.from(card.querySelectorAll('[class*="JobSearchCard-primary-tagsLink"], .tag'))
          .map((s) => s.textContent.trim()).filter(Boolean).slice(0, 8);
        const posted = (card.querySelector('[class*="JobSearchCard-primary-duration"], time')?.textContent || '').trim();
        if (title && href) out.push({ title, href, snippet, budget, skills, posted });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      projects.push({
        id: makeProjId(),
        title: j.title,
        description: j.snippet,
        platform: 'Freelancer',
        budget: j.budget || extractBudget(j.snippet),
        skills: j.skills.length ? j.skills : extractSkills(j.snippet),
        postedAt: j.posted,
        listingUrl: j.href.startsWith('http') ? j.href : `https://www.freelancer.com${j.href}`,
        contactName: '',
        location: location || '',
        projectType: 'fixed',
        source: 'freelancer'
      });
    }
  } catch (_) { /* fall through */ }

  // Fallback: DDG
  if (!projects.length) {
    const q = `site:freelancer.com/projects ${keywords}${location ? ` ${location}` : ''}`;
    const results = await searchDDG(page, q, maxResults);
    for (const r of results) {
      if (!r.url.includes('freelancer.com') || !r.url.match(/\/(projects?|jobs?)\//)) continue;
      projects.push({
        id: makeProjId(),
        title: stripPlatformSuffix(r.title),
        description: r.snippet,
        platform: 'Freelancer',
        budget: extractBudget(r.title + ' ' + r.snippet),
        skills: extractSkills(r.snippet),
        postedAt: '',
        listingUrl: r.url,
        contactName: '',
        location: location || '',
        projectType: 'fixed',
        source: 'freelancer'
      });
    }
  }

  return projects;
}

// ─── PeoplePerHour ────────────────────────────────────────────────────────────

async function searchPeoplePerHour(page, { keywords, maxResults }) {
  const projects = [];

  try {
    const url = `https://www.peopleperhour.com/freelance-jobs?q=${encodeURIComponent(keywords)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(
        document.querySelectorAll('[class*="card"], [class*="listing"], [class*="job-item"], article')
      ).slice(0, 30)) {
        const titleEl = card.querySelector('h2 a, h3 a, a[href*="/job/"]');
        const title = (titleEl?.textContent || '').trim();
        const href = titleEl?.href || '';
        if (!title || !href || !href.includes('peopleperhour.com')) continue;
        const snippet = (card.querySelector('p, [class*="desc"]')?.textContent || '').trim().slice(0, 280);
        const budget = (card.querySelector('[class*="price"], [class*="budget"]')?.textContent || '').trim();
        out.push({ title, href, snippet, budget });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      projects.push({
        id: makeProjId(),
        title: j.title,
        description: j.snippet,
        platform: 'PeoplePerHour',
        budget: j.budget || extractBudget(j.snippet),
        skills: extractSkills(j.snippet),
        postedAt: '',
        listingUrl: j.href,
        contactName: '',
        location: '',
        projectType: 'fixed',
        source: 'pph'
      });
    }
  } catch (_) { /* fall through */ }

  // Fallback: DDG
  if (!projects.length) {
    const q = `site:peopleperhour.com ${keywords}`;
    const results = await searchDDG(page, q, maxResults);
    for (const r of results) {
      if (!r.url.includes('peopleperhour.com') || !r.url.includes('/job')) continue;
      projects.push({
        id: makeProjId(),
        title: stripPlatformSuffix(r.title),
        description: r.snippet,
        platform: 'PeoplePerHour',
        budget: extractBudget(r.title + ' ' + r.snippet),
        skills: extractSkills(r.snippet),
        postedAt: '',
        listingUrl: r.url,
        contactName: '',
        location: '',
        projectType: 'fixed',
        source: 'pph'
      });
    }
  }

  return projects;
}

// ─── Guru.com ─────────────────────────────────────────────────────────────────

async function searchGuru(page, { keywords, maxResults }) {
  const projects = [];

  // DDG site search — Guru is heavily bot-protected for direct scraping
  const q = `site:guru.com/d/jobs ${keywords}`;
  const results = await searchDDG(page, q, maxResults);
  for (const r of results) {
    if (!r.url.match(/guru\.com\/(d\/jobs|job)/i)) continue;
    projects.push({
      id: makeProjId(),
      title: stripPlatformSuffix(r.title),
      description: r.snippet,
      platform: 'Guru',
      budget: extractBudget(r.title + ' ' + r.snippet),
      skills: extractSkills(r.snippet),
      postedAt: '',
      listingUrl: r.url,
      contactName: '',
      location: '',
      projectType: 'fixed',
      source: 'guru'
    });
  }
  return projects;
}

// ─── Web RFPs & Government Tenders ───────────────────────────────────────────

const FREELANCE_DOMAINS = /upwork\.com|freelancer\.com|guru\.com|peopleperhour\.com|fiverr\.com|toptal\.com|indeed\.com|seek\.com|linkedin\.com|glassdoor\.com/i;
const GOVT_DOMAINS = /\.gov\.au|\.gov\.uk|\.gov\.nz|\.gov\.sg|\.gov|sam\.gov|tenders\.gov|austender|ted\.europa|nzbn\.govt/i;

async function searchWebRFPs(page, { keywords, location, maxResults }) {
  const projects = [];
  const seen = new Set();

  const queries = [
    `"request for proposal" OR RFP IT outsourcing "staff augmentation" ${location || ''}`,
    `"statement of work" OR SOW software development services tender ${keywords} ${location || ''}`,
    `government tender IT technology procurement "${keywords}" ${location || ''}`,
    `"IT contract" OR "technology services" RFP tender ${location || ''} ${keywords}`
  ];

  for (const query of queries) {
    if (projects.length >= maxResults) break;
    const results = await searchDDG(page, query, 12);
    for (const r of results) {
      if (projects.length >= maxResults) break;
      if (FREELANCE_DOMAINS.test(r.url)) continue;
      if (seen.has(r.url)) continue;
      seen.add(r.url);

      const isGovt = GOVT_DOMAINS.test(r.url);
      projects.push({
        id: makeProjId(),
        title: stripPlatformSuffix(r.title) || 'IT Project RFP',
        description: r.snippet,
        platform: isGovt ? 'Government Tender' : 'Web RFP',
        budget: extractBudget(r.title + ' ' + r.snippet),
        skills: extractSkills(r.snippet),
        postedAt: '',
        listingUrl: r.url,
        contactName: '',
        location: location || '',
        projectType: isGovt ? 'tender' : 'rfp',
        source: isGovt ? 'government' : 'web_rfp'
      });
    }
    if (projects.length < maxResults) await sleep(800);
  }

  return projects;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runProjectSearch({
  keywords, location, resourceType, sources, maxPerSource,
  onProgress, onResult, signal
}) {
  const isCancelled = () => signal?.aborted === true;

  const resourceMap = {
    developers: 'software developer web developer full stack',
    devops: 'DevOps cloud engineer infrastructure',
    data: 'data engineer data scientist analytics',
    design: 'UX designer UI designer product design',
    architecture: 'solution architect enterprise architect',
    any: 'IT staff augmentation software development'
  };

  const searchKeywords = keywords || resourceMap[resourceType] || 'IT staff augmentation';

  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const seenUrls = new Set();

  function emit(proj) {
    if (!proj.listingUrl || seenUrls.has(proj.listingUrl)) return;
    seenUrls.add(proj.listingUrl);
    onResult(proj);
  }

  try {
    const page = await context.newPage();

    if (sources.includes('upwork') && !isCancelled()) {
      onProgress('Searching Upwork…');
      const results = await searchUpwork(page, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('freelancer') && !isCancelled()) {
      onProgress('Searching Freelancer.com…');
      const results = await searchFreelancer(page, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('pph') && !isCancelled()) {
      onProgress('Searching PeoplePerHour…');
      const results = await searchPeoplePerHour(page, { keywords: searchKeywords, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('guru') && !isCancelled()) {
      onProgress('Searching Guru.com…');
      const results = await searchGuru(page, { keywords: searchKeywords, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('web') && !isCancelled()) {
      onProgress('Searching for RFPs & government tenders…');
      const results = await searchWebRFPs(page, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

  } finally {
    await browser.close().catch(() => null);
  }
}

// ─── Job manager ──────────────────────────────────────────────────────────────

function createProjectJobManager() {
  const jobs = new Map();

  function createJob({ sources, params }) {
    const id = `projjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id, status: 'running', phase: 'starting',
      startedAt: new Date().toISOString(), finishedAt: null,
      found: 0, results: [], error: null, sources, params
    };
    jobs.set(id, job);
    return job;
  }

  function getJob(id) { return jobs.get(id) || null; }

  function setPhase(id, phase) {
    const job = jobs.get(id);
    if (job) job.phase = phase;
  }

  function appendResult(id, project) {
    const job = jobs.get(id);
    if (!job) return;
    job.results.push(project);
    job.found = job.results.length;
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

module.exports = { runProjectSearch, createProjectJobManager };
