'use strict';
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread = 800) => sleep(base + Math.random() * spread);

function makeProjId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function extractBudget(text) {
  const m = text.match(/(?:USD?\s*)?\$[\d,]+(?:k)?(?:\s*[-–]+\s*\$?[\d,]+k?)?(?:\s*\/\s*(?:hr|hour|month|mo|yr|year))?/i)
    || text.match(/(?:budget|rate|price)[:\s]+[\d,]+(?:\s*[-–]\s*[\d,]+)?/i);
  return m ? m[0].trim() : '';
}

const SKILL_LIST = [
  'React','Angular','Vue','Next.js','Nuxt','Svelte','Node.js','Express','NestJS',
  'Python','Django','FastAPI','Flask','Java','Spring','Kotlin','PHP','Laravel',
  'Ruby','Rails','.NET','C#','C++','Go','Rust','TypeScript','JavaScript',
  'AWS','Azure','GCP','DevOps','Docker','Kubernetes','Terraform','CI/CD',
  'PostgreSQL','MySQL','MongoDB','Redis','Elasticsearch','DynamoDB',
  'Swift','iOS','Android','Flutter','React Native','Xamarin',
  'Salesforce','SAP','ServiceNow','Shopify','Magento','WordPress',
  'AI','ML','Machine Learning','Deep Learning','LLM','GPT','Data Science',
  'Data Engineering','Analytics','Power BI','Tableau','Databricks',
  'Blockchain','Smart Contracts','Solidity','Web3',
  'Cybersecurity','Penetration Testing','QA','Automation Testing','Selenium',
  'UX','UI Design','Figma','Sketch','Scrum','Agile','Microservices','GraphQL','REST API'
];

function extractSkills(text) {
  const lower = text.toLowerCase();
  return SKILL_LIST.filter((s) => lower.includes(s.toLowerCase())).slice(0, 10);
}

const IT_SIGNAL = /\b(software|developer|engineer|devops|cloud|api|app|application|platform|system|database|backend|frontend|fullstack|full.?stack|mobile|web|tech|IT|technology|digital|data|ml|ai|cyber|saas|infrastructure|microservice|integration|migration|automation|qa|testing|ui|ux|react|angular|vue|node|python|java|php|aws|azure|gcp|kubernetes|docker)\b/i;

function isITRelevant(text) {
  return IT_SIGNAL.test(text);
}

function stripSuffix(title) {
  return title
    .replace(/\s*[-–|]\s*(Upwork|Freelancer|PeoplePerHour|Guru|Toptal|Fiverr|LinkedIn|Bark|Clutch|Indeed|Seek|Glassdoor|ZipRecruiter).*/i, '')
    .replace(/\s*\|.*$/, '')
    .trim();
}

// ─── Browser ──────────────────────────────────────────────────────────────────

const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled'
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, args: BROWSER_ARGS });
  } catch (err) {
    throw new Error(
      `Project Finder could not launch a browser: ${err.message}. ` +
      'Run "npx playwright install chromium" to install the bundled browser.'
    );
  }
}

async function newContext(browser) {
  return browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
}

// ─── DuckDuckGo multi-query engine ───────────────────────────────────────────
// Each call opens a FRESH context to avoid rate-limit carry-over between sources.

async function ddgSearch(browser, query) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const results = [];
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=en-us`, {
      waitUntil: 'domcontentloaded', timeout: 25000
    });
    await jitter(1000, 600);

    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.result:not(.result--ad), .web-result')).slice(0, 20).map((div) => {
        const a = div.querySelector('.result__title a, h2 a');
        const snip = div.querySelector('.result__snippet');
        return {
          title: (a?.textContent || '').trim(),
          url: a?.href || '',
          snippet: (snip?.textContent || '').trim().slice(0, 400)
        };
      }).filter((r) => r.title && r.url && !r.url.includes('duckduckgo'))
    );
    results.push(...raw);
  } catch (_) { /* source unavailable */ }
  finally { await ctx.close().catch(() => null); }
  return results;
}

// Run several query variations and merge unique URLs
async function ddgMulti(browser, queries, { filterFn, maxTotal = 40 } = {}) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    if (out.length >= maxTotal) break;
    const batch = await ddgSearch(browser, q);
    for (const r of batch) {
      if (out.length >= maxTotal) break;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      if (filterFn && !filterFn(r)) continue;
      out.push(r);
    }
    await jitter(800, 500);
  }
  return out;
}

// ─── Build project from a DDG result ─────────────────────────────────────────

function ddgToProject(r, platform, source, { location = '', projectType = 'fixed' } = {}) {
  return {
    id: makeProjId(),
    title: stripSuffix(r.title) || 'IT Project',
    description: r.snippet,
    platform,
    budget: extractBudget(r.title + ' ' + r.snippet),
    skills: extractSkills(r.snippet),
    postedAt: '',
    listingUrl: r.url,
    contactName: '',
    location,
    projectType,
    source
  };
}

// ─── 1. Upwork ────────────────────────────────────────────────────────────────

async function searchUpwork(browser, { keywords, location, maxResults }) {
  // Try direct scrape first (single context for Upwork)
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const projects = [];

  try {
    const url = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(keywords)}&sort=recency${location ? `&location=${encodeURIComponent(location)}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await jitter(3000, 1000);

    const jobs = await page.evaluate(() => {
      const out = [];
      const cards = document.querySelectorAll('[data-test="job-tile"], section[data-job-uid], .job-tile, article[data-ev-job-uid]');
      for (const card of Array.from(cards).slice(0, 40)) {
        const titleEl = card.querySelector('h2 a, h3 a, [data-test="job-title"], a[class*="title"]');
        const title = (titleEl?.textContent || '').trim();
        const href = titleEl?.href || '';
        const snippet = (card.querySelector('[data-test="job-description-text"], [class*="description"], .air3-line-clamp')?.textContent || '').trim().slice(0, 350);
        const budget = (card.querySelector('[data-test="budget"], [class*="budget"], [class*="rate"]')?.textContent || '').trim();
        const skills = Array.from(card.querySelectorAll('[data-test="token"], [class*="skill"]')).map((s) => s.textContent.trim()).slice(0, 10);
        const posted = (card.querySelector('[data-test="posted-on"], time')?.textContent || '').trim();
        if (title && href) out.push({ title, href, snippet, budget, skills, posted });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
      projects.push({
        id: makeProjId(),
        title: j.title,
        description: j.snippet,
        platform: 'Upwork',
        budget: j.budget || extractBudget(j.snippet),
        skills: j.skills.length ? j.skills : extractSkills(j.snippet),
        postedAt: j.posted,
        listingUrl: j.href.startsWith('http') ? j.href : `https://www.upwork.com${j.href}`,
        contactName: '',
        location: location || '',
        projectType: (j.budget || '').toLowerCase().includes('/hr') ? 'hourly' : 'fixed',
        source: 'upwork'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  // Supplement / fallback with DDG multi-query
  if (projects.length < maxResults) {
    const queries = [
      `site:upwork.com/jobs ${keywords} ${location || ''}`,
      `site:upwork.com/jobs "IT staff augmentation" ${location || ''}`,
      `site:upwork.com/jobs "software development team" ${location || ''}`,
      `site:upwork.com/jobs "staff augmentation" developers`,
      `site:upwork.com/jobs "full stack" OR "react" OR "node.js" ${location || ''}`
    ];
    const results = await ddgMulti(browser, queries, {
      maxTotal: maxResults - projects.length,
      filterFn: (r) => r.url.match(/upwork\.com\/(jobs|freelance-jobs|o\/jobs)/) && isITRelevant(r.title + ' ' + r.snippet)
    });
    const existingUrls = new Set(projects.map((p) => p.listingUrl));
    for (const r of results) {
      if (existingUrls.has(r.url)) continue;
      projects.push(ddgToProject(r, 'Upwork', 'upwork', { location }));
    }
  }

  return projects.slice(0, maxResults);
}

// ─── 2. Freelancer ────────────────────────────────────────────────────────────

async function searchFreelancer(browser, { keywords, location, maxResults }) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const projects = [];

  // Try direct scrape
  try {
    const slug = keywords.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await page.goto(`https://www.freelancer.com/jobs/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await jitter(2500, 800);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.JobSearchCard-item, [class*="JobSearchCard"]')).slice(0, 40)) {
        const titleEl = card.querySelector('a.JobSearchCard-primary-heading-link, h2 a, a[href*="/projects/"]');
        const title = (titleEl?.textContent || '').trim();
        const href = titleEl?.href || '';
        const snippet = (card.querySelector('[class*="description"], p')?.textContent || '').trim().slice(0, 350);
        const budget = (card.querySelector('[class*="JobSearchCard-primary-price"]')?.textContent || '').trim();
        const skills = Array.from(card.querySelectorAll('[class*="JobSearchCard-primary-tagsLink"]')).map((s) => s.textContent.trim()).slice(0, 8);
        if (title && href) out.push({ title, href, snippet, budget, skills });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
      projects.push({
        id: makeProjId(),
        title: j.title,
        description: j.snippet,
        platform: 'Freelancer',
        budget: j.budget || extractBudget(j.snippet),
        skills: j.skills.length ? j.skills : extractSkills(j.snippet),
        postedAt: '',
        listingUrl: j.href.startsWith('http') ? j.href : `https://www.freelancer.com${j.href}`,
        contactName: '',
        location: location || '',
        projectType: 'fixed',
        source: 'freelancer'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  // DDG supplement
  if (projects.length < maxResults) {
    const queries = [
      `site:freelancer.com/projects "software development" ${location || ''}`,
      `site:freelancer.com/projects "staff augmentation" OR "development team"`,
      `site:freelancer.com/projects "${keywords}"`,
      `site:freelancer.com/projects "web application" OR "mobile app" ${location || ''}`,
      `site:freelancer.com/projects "backend" OR "frontend" OR "fullstack"`
    ];
    const results = await ddgMulti(browser, queries, {
      maxTotal: maxResults - projects.length,
      filterFn: (r) => r.url.match(/freelancer\.com\/(projects?|jobs?)\//) && isITRelevant(r.title + ' ' + r.snippet)
    });
    const existingUrls = new Set(projects.map((p) => p.listingUrl));
    for (const r of results) {
      if (existingUrls.has(r.url)) continue;
      projects.push(ddgToProject(r, 'Freelancer', 'freelancer', { location }));
    }
  }

  return projects.slice(0, maxResults);
}

// ─── 3. PeoplePerHour ────────────────────────────────────────────────────────

async function searchPeoplePerHour(browser, { keywords, maxResults }) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const projects = [];

  try {
    await page.goto(`https://www.peopleperhour.com/freelance-jobs?q=${encodeURIComponent(keywords)}&filter=projects`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await jitter(2000, 600);

    const jobs = await page.evaluate(() => {
      const out = [];
      const selectors = '[class*="card"], [class*="listing"], [class*="job-item"], [class*="project"], article';
      for (const card of Array.from(document.querySelectorAll(selectors)).slice(0, 40)) {
        const titleEl = card.querySelector('h2 a, h3 a, a[href*="/job/"], a[href*="/project/"]');
        if (!titleEl) continue;
        const title = titleEl.textContent.trim();
        const href = titleEl.href;
        if (!title || !href || !href.includes('peopleperhour.com')) continue;
        const snippet = (card.querySelector('p, [class*="desc"], [class*="summary"]')?.textContent || '').trim().slice(0, 350);
        const budget = (card.querySelector('[class*="price"], [class*="budget"], [class*="amount"]')?.textContent || '').trim();
        out.push({ title, href, snippet, budget });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
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
  finally { await ctx.close().catch(() => null); }

  // DDG supplement
  if (projects.length < maxResults) {
    const queries = [
      `site:peopleperhour.com ${keywords}`,
      `site:peopleperhour.com "software development" OR "web development"`,
      `site:peopleperhour.com "staff augmentation" OR "development team"`
    ];
    const results = await ddgMulti(browser, queries, {
      maxTotal: maxResults - projects.length,
      filterFn: (r) => r.url.includes('peopleperhour.com') && isITRelevant(r.title + ' ' + r.snippet)
    });
    const existingUrls = new Set(projects.map((p) => p.listingUrl));
    for (const r of results) {
      if (existingUrls.has(r.url)) continue;
      projects.push(ddgToProject(r, 'PeoplePerHour', 'pph'));
    }
  }

  return projects.slice(0, maxResults);
}

// ─── 4. Guru.com ─────────────────────────────────────────────────────────────

async function searchGuru(browser, { keywords, maxResults }) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const projects = [];

  // Try direct scrape
  try {
    await page.goto(`https://www.guru.com/d/jobs/q/${encodeURIComponent(keywords)}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await jitter(2000, 600);

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.serviceItem, [class*="job"], li[class*="list"]')).slice(0, 30)) {
        const titleEl = card.querySelector('a[href*="/d/jobs/"]');
        if (!titleEl) continue;
        const title = titleEl.textContent.trim();
        const href = titleEl.href;
        const snippet = (card.querySelector('p, [class*="desc"]')?.textContent || '').trim().slice(0, 300);
        const budget = (card.querySelector('[class*="price"], [class*="budget"]')?.textContent || '').trim();
        if (title && href) out.push({ title, href, snippet, budget });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
      projects.push({
        id: makeProjId(),
        title: j.title,
        description: j.snippet,
        platform: 'Guru',
        budget: j.budget || extractBudget(j.snippet),
        skills: extractSkills(j.snippet),
        postedAt: '',
        listingUrl: j.href,
        contactName: '',
        location: '',
        projectType: 'fixed',
        source: 'guru'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  // DDG supplement
  if (projects.length < maxResults) {
    const queries = [
      `site:guru.com/d/jobs ${keywords}`,
      `site:guru.com/d/jobs "software development" OR "web development"`,
      `site:guru.com/d/jobs "staff augmentation"`
    ];
    const results = await ddgMulti(browser, queries, {
      maxTotal: maxResults - projects.length,
      filterFn: (r) => r.url.match(/guru\.com\/(d\/jobs|job)/) && isITRelevant(r.title + ' ' + r.snippet)
    });
    const existingUrls = new Set(projects.map((p) => p.listingUrl));
    for (const r of results) {
      if (existingUrls.has(r.url)) continue;
      projects.push(ddgToProject(r, 'Guru', 'guru'));
    }
  }

  return projects.slice(0, maxResults);
}

// ─── 5. Reddit r/forhire ─────────────────────────────────────────────────────

async function searchReddit(browser, { keywords, maxResults }) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const projects = [];

  try {
    // Use Reddit's JSON API (no login needed for new posts)
    await page.goto(`https://www.reddit.com/r/forhire/search.json?q=%5BHIRING%5D+${encodeURIComponent(keywords)}&restrict_sr=1&sort=new&limit=50`, {
      waitUntil: 'domcontentloaded', timeout: 25000
    });
    await jitter(1000, 400);

    const data = await page.evaluate(() => {
      try { return JSON.parse(document.body.innerText); } catch { return null; }
    });

    if (data?.data?.children) {
      for (const child of data.data.children) {
        if (projects.length >= maxResults) break;
        const post = child.data;
        if (!post.title?.includes('[HIRING]') && !post.link_flair_text?.toLowerCase().includes('hiring')) continue;
        const text = post.selftext || '';
        if (!isITRelevant(post.title + ' ' + text)) continue;

        projects.push({
          id: makeProjId(),
          title: post.title.replace(/^\[HIRING\]\s*/i, '').trim(),
          description: text.slice(0, 400),
          platform: 'Reddit r/forhire',
          budget: extractBudget(text),
          skills: extractSkills(text),
          postedAt: post.created_utc ? new Date(post.created_utc * 1000).toLocaleDateString() : '',
          listingUrl: `https://reddit.com${post.permalink}`,
          contactName: post.author ? `u/${post.author}` : '',
          location: '',
          projectType: 'fixed',
          source: 'reddit'
        });
      }
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  // Also search r/entrepreneur and r/startups for "looking for developers"
  if (projects.length < maxResults) {
    const ctx2 = await newContext(browser);
    const page2 = await ctx2.newPage();
    try {
      await page2.goto(`https://www.reddit.com/r/slavelabour+forhire+entrepreneur/search.json?q=${encodeURIComponent(`[HIRING] ${keywords}`)}&sort=new&limit=25&t=month`, {
        waitUntil: 'domcontentloaded', timeout: 20000
      });
      await jitter(800, 400);
      const data2 = await page2.evaluate(() => {
        try { return JSON.parse(document.body.innerText); } catch { return null; }
      });
      if (data2?.data?.children) {
        for (const child of data2.data.children) {
          if (projects.length >= maxResults) break;
          const post = child.data;
          const text = post.selftext || '';
          if (!isITRelevant(post.title + ' ' + text)) continue;
          const url = `https://reddit.com${post.permalink}`;
          if (projects.some((p) => p.listingUrl === url)) continue;
          projects.push({
            id: makeProjId(),
            title: post.title.replace(/^\[(HIRING|FOR HIRE|H)\]\s*/i, '').trim(),
            description: text.slice(0, 400),
            platform: 'Reddit',
            budget: extractBudget(text),
            skills: extractSkills(text),
            postedAt: post.created_utc ? new Date(post.created_utc * 1000).toLocaleDateString() : '',
            listingUrl: url,
            contactName: post.author ? `u/${post.author}` : '',
            location: '',
            projectType: 'fixed',
            source: 'reddit'
          });
        }
      }
    } catch (_) { /* skip */ }
    finally { await ctx2.close().catch(() => null); }
  }

  return projects.slice(0, maxResults);
}

// ─── 6. LinkedIn contract jobs ────────────────────────────────────────────────

async function searchLinkedInContracts(browser, { keywords, location, maxResults }) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const projects = [];

  try {
    // f_JT=C = Contract job type, f_WT=2 = Remote
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location || '')}&f_JT=C&sortBy=DD`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await jitter(2500, 800);

    // Dismiss modals
    for (const sel of ['button[aria-label*="Dismiss"]', 'button.modal__dismiss']) {
      await page.locator(sel).first().click({ timeout: 1500 }).catch(() => null);
    }

    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.base-card, .job-search-card')).slice(0, 30)) {
        const title = (card.querySelector('h3.base-search-card__title, .job-card-list__title')?.textContent || '').trim();
        const company = (card.querySelector('h4.base-search-card__subtitle, .base-search-card__subtitle')?.textContent || '').trim();
        const loc = (card.querySelector('.job-search-card__location, .base-search-card__metadata')?.textContent || '').trim();
        const href = card.querySelector('a[href*="/jobs/view/"]')?.href || '';
        if (title && href) out.push({ title, company, loc, href });
      }
      return out;
    });

    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.company)) continue;
      projects.push({
        id: makeProjId(),
        title: `[Contract] ${j.title}`,
        description: `${j.company} is hiring a ${j.title} on a contract basis.`,
        platform: 'LinkedIn',
        budget: '',
        skills: extractSkills(j.title),
        postedAt: '',
        listingUrl: j.href,
        contactName: j.company,
        location: j.loc,
        projectType: 'contract',
        source: 'linkedin'
      });
    }
  } catch (_) { /* skip */ }
  finally { await ctx.close().catch(() => null); }

  return projects;
}

// ─── 7. Staff augmentation web-wide deep search ──────────────────────────────

const FREELANCE_DOMAINS = /upwork\.com|freelancer\.com|guru\.com|peopleperhour\.com|fiverr\.com|toptal\.com|bark\.com|contra\.com|indeed\.com|seek\.com|linkedin\.com|glassdoor\.com|ziprecruiter|monster\.com|careerbuilder/i;

async function searchStaffAugWeb(browser, { keywords, location, maxResults }) {
  const loc = location || '';
  const queries = [
    // Staff augmentation specific
    `"IT staff augmentation" company ${loc} "looking for" OR "need" developers 2025`,
    `"staff augmentation" "software development" ${loc} partner vendor`,
    `"augment our team" OR "extend our team" IT developers engineers ${loc}`,
    `"need IT staff" OR "looking for IT professionals" outsource ${loc} 2025`,
    `"staff augmentation services" ${keywords} ${loc}`,
    // Outsourcing
    `"outsource software development" OR "outsource IT" ${loc} project 2025`,
    `"nearshore" OR "offshore" software development partner ${loc} looking`,
    `"IT outsourcing" project ${loc} "request for" 2025`,
    // Build / develop
    `"looking for a development team" OR "looking for developers" ${keywords} ${loc}`,
    `"need to build" OR "want to build" software application ${keywords} ${loc} 2025`,
    `"hire a development team" OR "hire developers" ${loc} ${keywords}`,
    `"build our platform" OR "build our product" software team ${loc}`
  ].map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const results = await ddgMulti(browser, queries, {
    maxTotal: maxResults,
    filterFn: (r) => !FREELANCE_DOMAINS.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });

  return results.map((r) => ({
    id: makeProjId(),
    title: stripSuffix(r.title) || 'IT Staff Augmentation Opportunity',
    description: r.snippet,
    platform: 'Web',
    budget: extractBudget(r.title + ' ' + r.snippet),
    skills: extractSkills(r.snippet),
    postedAt: '',
    listingUrl: r.url,
    contactName: '',
    location: loc,
    projectType: 'contract',
    source: 'web_staffaug'
  })).slice(0, maxResults);
}

// ─── 8. RFPs / Tenders / Government ──────────────────────────────────────────

const GOVT_RE = /\.gov\.au|\.gov\.uk|\.gov\.nz|\.gov\.sg|\.gov\.ca|\.gov\b|sam\.gov|tenders\.gov|austender|ted\.europa|find-tender\.service\.gov|nzbn\.govt|etenders|sourceau/i;

async function searchRFPsAndTenders(browser, { keywords, location, maxResults }) {
  const loc = location || '';
  const queries = [
    // Government tenders
    `government tender "IT services" OR "software development" OR "digital transformation" ${loc} 2025`,
    `"request for tender" OR "expression of interest" IT technology ${loc} 2025`,
    `site:tenders.gov.au software OR technology OR digital 2025`,
    `site:sam.gov "software development" OR "IT services" OR "staff augmentation" 2025`,
    `site:find-tender.service.gov.uk software development OR IT services 2025`,
    // RFPs
    `"request for proposal" "software development" OR "digital transformation" ${loc} 2025`,
    `RFP "IT outsourcing" OR "managed services" OR "application development" ${loc}`,
    `"statement of work" "software development" "looking for" vendor ${loc} 2025`,
    `"IT contract" outsource "development team" RFP OR SOW ${loc}`,
    // Innovation / startup programs
    `"looking for technology partner" OR "technology provider" project ${loc} 2025`,
    `"digital transformation" project "IT partner" OR "technology vendor" ${loc}`
  ].map((q) => q.replace(/\s+/g, ' ').trim());

  const results = await ddgMulti(browser, queries, {
    maxTotal: maxResults,
    filterFn: (r) => !FREELANCE_DOMAINS.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });

  return results.map((r) => {
    const isGovt = GOVT_RE.test(r.url);
    return {
      id: makeProjId(),
      title: stripSuffix(r.title) || 'IT Project RFP',
      description: r.snippet,
      platform: isGovt ? 'Government Tender' : 'Web RFP',
      budget: extractBudget(r.title + ' ' + r.snippet),
      skills: extractSkills(r.snippet),
      postedAt: '',
      listingUrl: r.url,
      contactName: '',
      location: loc,
      projectType: isGovt ? 'tender' : 'rfp',
      source: isGovt ? 'government' : 'web_rfp'
    };
  }).slice(0, maxResults);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runProjectSearch({
  keywords, location, resourceType, sources, maxPerSource,
  onProgress, onResult, signal
}) {
  const isCancelled = () => signal?.aborted === true;

  const resourceMap = {
    developers: 'software developer web developer full stack development',
    devops:     'DevOps cloud engineer infrastructure automation',
    data:       'data engineer data scientist analytics pipeline',
    design:     'UX designer UI designer product design',
    architecture: 'solution architect enterprise architect',
    any:        'IT staff augmentation software development technology'
  };

  const searchKeywords = keywords || resourceMap[resourceType] || 'IT staff augmentation software development';

  const browser = await launchBrowser();
  const seenUrls = new Set();

  function emit(proj) {
    if (!proj.listingUrl || seenUrls.has(proj.listingUrl)) return;
    seenUrls.add(proj.listingUrl);
    onResult(proj);
  }

  try {
    if (sources.includes('upwork') && !isCancelled()) {
      onProgress('Searching Upwork (direct + 5 query variations)…');
      const results = await searchUpwork(browser, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('freelancer') && !isCancelled()) {
      onProgress('Searching Freelancer (direct + 5 query variations)…');
      const results = await searchFreelancer(browser, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('pph') && !isCancelled()) {
      onProgress('Searching PeoplePerHour…');
      const results = await searchPeoplePerHour(browser, { keywords: searchKeywords, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('guru') && !isCancelled()) {
      onProgress('Searching Guru.com…');
      const results = await searchGuru(browser, { keywords: searchKeywords, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('reddit') && !isCancelled()) {
      onProgress('Searching Reddit r/forhire for [HIRING] posts…');
      const results = await searchReddit(browser, { keywords: searchKeywords, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('linkedin') && !isCancelled()) {
      onProgress('Searching LinkedIn contract jobs…');
      const results = await searchLinkedInContracts(browser, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('staffaug') && !isCancelled()) {
      onProgress('Deep web search for staff augmentation opportunities (12 queries)…');
      const results = await searchStaffAugWeb(browser, { keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
      results.forEach(emit);
    }

    if (sources.includes('web') && !isCancelled()) {
      onProgress('Searching RFPs, tenders & government procurement (11 queries)…');
      const results = await searchRFPsAndTenders(browser, { keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
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
