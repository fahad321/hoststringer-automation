'use strict';
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread = 600) => sleep(base + Math.random() * spread);

function makeProjId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const CURRENT_YEAR = new Date().getFullYear();

// ─── Text helpers ─────────────────────────────────────────────────────────────

function extractBudget(text) {
  const m = text.match(/(?:USD?)?\$\s*[\d,]+(?:k)?(?:\s*[-–]+\s*\$?\s*[\d,]+k?)?(?:\s*\/\s*(?:hr|hour|month|mo|yr|year))?/i)
    || text.match(/(?:budget|rate|price|pay)[:\s]+[\d,]+(?:\s*[-–]\s*[\d,]+)?/i);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

const SKILL_LIST = [
  'React','Angular','Vue','Next.js','Nuxt','Svelte','Node.js','Express','NestJS',
  'Python','Django','FastAPI','Flask','Java','Spring','Kotlin','PHP','Laravel',
  'Ruby','Rails','.NET','C#','C++','Go','Rust','TypeScript','JavaScript',
  'AWS','Azure','GCP','DevOps','Docker','Kubernetes','Terraform','CI/CD',
  'PostgreSQL','MySQL','MongoDB','Redis','Elasticsearch','DynamoDB',
  'Swift','iOS','Android','Flutter','React Native',
  'Salesforce','SAP','ServiceNow','Shopify','Magento','WordPress',
  'AI','ML','Machine Learning','Deep Learning','LLM','GPT','Data Science',
  'Data Engineering','Power BI','Tableau','Databricks',
  'Blockchain','Web3','Solidity','Cybersecurity','QA','Automation',
  'UX','UI','Figma','Scrum','Agile','Microservices','GraphQL','REST API'
];

function extractSkills(text) {
  const lower = text.toLowerCase();
  return SKILL_LIST.filter((s) => lower.includes(s.toLowerCase())).slice(0, 8);
}

const IT_SIGNAL = /\b(software|developer|engineer|devops|cloud|api|app|application|platform|system|database|backend|frontend|fullstack|mobile|web|tech(?:nology)?|IT|digital|data|saas|infrastructure|microservice|qa|testing|react|angular|vue|node|python|java|php|aws|azure|gcp|kubernetes|docker|blockchain|cybersecurity)\b/i;

function isITRelevant(text) { return IT_SIGNAL.test(text); }

function stripSuffix(title) {
  return title
    .replace(/\s*[-–|]\s*(Upwork|Freelancer|PeoplePerHour|Guru|Toptal|Fiverr|LinkedIn|Reddit|Indeed|Seek|Glassdoor).*/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .trim();
}

// ─── Fetch-based DuckDuckGo search (GET, no browser fingerprint) ─────────────
// DDG rate-limits after ~3 consecutive rapid requests. Strategy:
//   • Use GET (not POST — POST triggers 202 responses)
//   • Enforce minimum 3s between queries
//   • Keep total query count low (≤3 per source)

const DDG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://duckduckgo.com/'
};

let lastDdgRequest = 0; // timestamp — enforces global 3s gap

async function ddgFetch(query, max = 12) {
  const results = [];
  try {
    // Global rate-limit: wait at least 3200ms since last DDG call
    const gap = Date.now() - lastDdgRequest;
    if (gap < 3200) await sleep(3200 - gap);
    lastDdgRequest = Date.now();

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=en-us`;
    const res = await fetch(url, { headers: DDG_HEADERS });
    if (!res.ok) return results;
    const html = await res.text();
    if (!html.includes('result__a')) return results; // bot page or empty

    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const urls = [], titles = [], snippets = [];
    let m;
    while ((m = linkRe.exec(html)) !== null && urls.length < max + 5) {
      const u = m[1];
      if (!u || u.includes('duckduckgo')) continue;
      urls.push(u);
      titles.push(m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim());
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < max + 5) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
    }
    for (let i = 0; i < Math.min(urls.length, max); i++) {
      results.push({ title: titles[i] || '', url: urls[i], snippet: (snippets[i] || '').slice(0, 400) });
    }
  } catch (_) { /* network error */ }
  return results;
}

// Run at most `maxQueries` queries, stop early if we have enough results
async function ddgMulti(queries, { filterFn, maxTotal = 20, maxQueries = 3 } = {}) {
  const seen = new Set();
  const out = [];
  let ran = 0;
  for (const q of queries) {
    if (out.length >= maxTotal || ran >= maxQueries) break;
    const batch = await ddgFetch(q, 12);
    ran++;
    for (const r of batch) {
      if (out.length >= maxTotal) break;
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      if (filterFn && !filterFn(r)) continue;
      out.push(r);
    }
  }
  return out;
}

function ddgToProject(r, platform, source, extra = {}) {
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
    location: extra.location || '',
    projectType: extra.projectType || 'fixed',
    source
  };
}

// ─── Browser (used only for platform scraping) ────────────────────────────────

const BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, args: BROWSER_ARGS });
  } catch (err) {
    throw new Error(`Project Finder could not launch a browser: ${err.message}. Run "npx playwright install chromium".`);
  }
}

async function newCtx(browser) {
  return browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
}

// ─── 1. Upwork ────────────────────────────────────────────────────────────────

async function searchUpwork(browser, { keywords, location, maxResults }) {
  const projects = [];
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();

  // Direct scrape
  try {
    const url = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(keywords)}&sort=recency${location ? `&location=${encodeURIComponent(location)}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await jitter(3000, 1000);
    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('[data-test="job-tile"], section[data-job-uid], article[data-ev-job-uid]')).slice(0, 40)) {
        const titleEl = card.querySelector('h2 a, h3 a, [data-test="job-title"], a[class*="title"]');
        const title = (titleEl?.textContent || '').trim();
        const href = titleEl?.href || '';
        const snippet = (card.querySelector('[data-test="job-description-text"], .air3-line-clamp, [class*="description"]')?.textContent || '').trim().slice(0, 350);
        const budget = (card.querySelector('[data-test="budget"], [class*="budget"], [class*="rate"]')?.textContent || '').trim();
        const skills = Array.from(card.querySelectorAll('[data-test="token"], [class*="skill"]')).map((s) => s.textContent.trim()).slice(0, 8);
        const posted = (card.querySelector('[data-test="posted-on"], time')?.textContent || '').trim();
        if (title && href) out.push({ title, href, snippet, budget, skills, posted });
      }
      return out;
    });
    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
      projects.push({
        id: makeProjId(), title: j.title, description: j.snippet,
        platform: 'Upwork',
        budget: j.budget || extractBudget(j.snippet),
        skills: j.skills.length ? j.skills : extractSkills(j.snippet),
        postedAt: j.posted,
        listingUrl: j.href.startsWith('http') ? j.href : `https://www.upwork.com${j.href}`,
        contactName: '', location: location || '',
        projectType: (j.budget || '').toLowerCase().includes('/hr') ? 'hourly' : 'fixed',
        source: 'upwork'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  // DDG supplement (max 2 queries — rate limit protection)
  if (projects.length < maxResults) {
    const queries = [
      `site:upwork.com/jobs ${keywords} ${location || ''}`,
      `site:upwork.com/jobs "staff augmentation" OR "development team" ${location || ''}`
    ];
    const seen = new Set(projects.map((p) => p.listingUrl));
    const results = await ddgMulti(queries, {
      maxTotal: maxResults - projects.length, maxQueries: 2,
      filterFn: (r) => /upwork\.com\/(jobs|freelance-jobs|o\/jobs)/.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
    });
    for (const r of results) {
      if (!seen.has(r.url)) projects.push(ddgToProject(r, 'Upwork', 'upwork', { location }));
    }
  }
  return projects.slice(0, maxResults);
}

// ─── 2. Freelancer ────────────────────────────────────────────────────────────

async function searchFreelancer(browser, { keywords, location, maxResults }) {
  const projects = [];
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();

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
        id: makeProjId(), title: j.title, description: j.snippet,
        platform: 'Freelancer',
        budget: j.budget || extractBudget(j.snippet),
        skills: j.skills.length ? j.skills : extractSkills(j.snippet),
        postedAt: '',
        listingUrl: j.href.startsWith('http') ? j.href : `https://www.freelancer.com${j.href}`,
        contactName: '', location: location || '', projectType: 'fixed', source: 'freelancer'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  if (projects.length < maxResults) {
    const queries = [
      `site:freelancer.com/projects "software development" ${location || ''}`,
      `site:freelancer.com/projects "web application" OR "mobile app" ${location || ''}`
    ];
    const seen = new Set(projects.map((p) => p.listingUrl));
    const results = await ddgMulti(queries, {
      maxTotal: maxResults - projects.length, maxQueries: 2,
      filterFn: (r) => /freelancer\.com\/(projects?|jobs?)\//.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
    });
    for (const r of results) {
      if (!seen.has(r.url)) projects.push(ddgToProject(r, 'Freelancer', 'freelancer', { location }));
    }
  }
  return projects.slice(0, maxResults);
}

// ─── 3. PeoplePerHour ────────────────────────────────────────────────────────

async function searchPeoplePerHour(browser, { keywords, maxResults }) {
  const projects = [];
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`https://www.peopleperhour.com/freelance-jobs?q=${encodeURIComponent(keywords)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await jitter(2000, 600);
    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('article, [class*="card"], [class*="listing"]')).slice(0, 40)) {
        const titleEl = card.querySelector('h2 a, h3 a, a[href*="/job/"], a[href*="/project/"]');
        if (!titleEl || !titleEl.href.includes('peopleperhour.com')) continue;
        const title = titleEl.textContent.trim();
        const snippet = (card.querySelector('p, [class*="desc"]')?.textContent || '').trim().slice(0, 300);
        const budget = (card.querySelector('[class*="price"], [class*="budget"]')?.textContent || '').trim();
        out.push({ title, href: titleEl.href, snippet, budget });
      }
      return out;
    });
    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
      projects.push({
        id: makeProjId(), title: j.title, description: j.snippet,
        platform: 'PeoplePerHour',
        budget: j.budget || extractBudget(j.snippet),
        skills: extractSkills(j.snippet), postedAt: '',
        listingUrl: j.href, contactName: '', location: '', projectType: 'fixed', source: 'pph'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  if (projects.length < maxResults) {
    const queries = [
      `site:peopleperhour.com ${keywords}`,
      `site:peopleperhour.com "software development" OR "web development"`
    ];
    const seen = new Set(projects.map((p) => p.listingUrl));
    const results = await ddgMulti(queries, {
      maxTotal: maxResults - projects.length, maxQueries: 2,
      filterFn: (r) => r.url.includes('peopleperhour.com') && isITRelevant(r.title + ' ' + r.snippet)
    });
    for (const r of results) {
      if (!seen.has(r.url)) projects.push(ddgToProject(r, 'PeoplePerHour', 'pph'));
    }
  }
  return projects.slice(0, maxResults);
}

// ─── 4. Guru ─────────────────────────────────────────────────────────────────

async function searchGuru(browser, { keywords, maxResults }) {
  const projects = [];
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`https://www.guru.com/d/jobs/q/${encodeURIComponent(keywords)}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await jitter(2000, 600);
    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.serviceItem, [class*="jobItem"], li[class*="list"]')).slice(0, 30)) {
        const titleEl = card.querySelector('a[href*="/d/jobs/"]');
        if (!titleEl) continue;
        const snippet = (card.querySelector('p, [class*="desc"]')?.textContent || '').trim().slice(0, 300);
        const budget = (card.querySelector('[class*="price"], [class*="budget"]')?.textContent || '').trim();
        out.push({ title: titleEl.textContent.trim(), href: titleEl.href, snippet, budget });
      }
      return out;
    });
    for (const j of jobs) {
      if (projects.length >= maxResults) break;
      if (!isITRelevant(j.title + ' ' + j.snippet)) continue;
      projects.push({
        id: makeProjId(), title: j.title, description: j.snippet,
        platform: 'Guru', budget: j.budget || extractBudget(j.snippet),
        skills: extractSkills(j.snippet), postedAt: '',
        listingUrl: j.href, contactName: '', location: '', projectType: 'fixed', source: 'guru'
      });
    }
  } catch (_) { /* fall through */ }
  finally { await ctx.close().catch(() => null); }

  if (projects.length < maxResults) {
    const queries = [
      `site:guru.com/d/jobs ${keywords}`,
      `site:guru.com/d/jobs "software development" OR "web development"`
    ];
    const seen = new Set(projects.map((p) => p.listingUrl));
    const results = await ddgMulti(queries, {
      maxTotal: maxResults - projects.length, maxQueries: 2,
      filterFn: (r) => /guru\.com\/(d\/jobs|job)/.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
    });
    for (const r of results) {
      if (!seen.has(r.url)) projects.push(ddgToProject(r, 'Guru', 'guru'));
    }
  }
  return projects.slice(0, maxResults);
}

// ─── 5. Reddit r/forhire (fetch-based JSON API) ───────────────────────────────

async function searchReddit({ keywords, maxResults }) {
  const projects = [];
  const seen = new Set();
  const subreddits = ['forhire', 'slavelabour', 'entrepreneur'];

  const redditHeaders = {
    'User-Agent': 'hoststringer-bot/1.0 (IT consultancy lead finder)',
    'Accept': 'application/json'
  };

  for (const sub of subreddits) {
    if (projects.length >= maxResults) break;
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent('[HIRING] ' + keywords)}&restrict_sr=1&sort=new&limit=30&t=month`;
      const res = await fetch(url, { headers: redditHeaders });
      if (!res.ok) continue;
      const data = await res.json();

      for (const child of (data?.data?.children || [])) {
        if (projects.length >= maxResults) break;
        const post = child.data;
        if (!post?.title) continue;

        // Only [HIRING] posts for actual project needs
        const isHiring = /\[HIRING\]|\[H\]\s/i.test(post.title) || post.link_flair_text?.toLowerCase().includes('hiring');
        if (!isHiring) continue;

        const text = `${post.title} ${post.selftext || ''}`;
        if (!isITRelevant(text)) continue;

        const postUrl = `https://reddit.com${post.permalink}`;
        if (seen.has(postUrl)) continue;
        seen.add(postUrl);

        projects.push({
          id: makeProjId(),
          title: stripSuffix(post.title.replace(/^\[HIRING\]\s*/i, '').replace(/^\[H\]\s*/i, '')),
          description: (post.selftext || '').slice(0, 400),
          platform: `Reddit r/${sub}`,
          budget: extractBudget(text),
          skills: extractSkills(text),
          postedAt: post.created_utc ? new Date(post.created_utc * 1000).toLocaleDateString() : '',
          listingUrl: postUrl,
          contactName: post.author ? `u/${post.author}` : '',
          location: '',
          projectType: extractBudget(text).toLowerCase().includes('/hr') ? 'hourly' : 'fixed',
          source: 'reddit'
        });
      }
    } catch (_) { /* skip sub */ }
    await jitter(500, 300);
  }
  return projects;
}

// ─── 6. LinkedIn contract jobs (browser) ─────────────────────────────────────

async function searchLinkedInContracts(browser, { keywords, location, maxResults }) {
  const projects = [];
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();

  try {
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location || '')}&f_JT=C&sortBy=DD`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await jitter(2500, 800);
    for (const sel of ['button[aria-label*="Dismiss"]', 'button.modal__dismiss']) {
      await page.locator(sel).first().click({ timeout: 1500 }).catch(() => null);
    }
    const jobs = await page.evaluate(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.base-card, .job-search-card')).slice(0, 30)) {
        const title = (card.querySelector('h3.base-search-card__title')?.textContent || '').trim();
        const company = (card.querySelector('h4.base-search-card__subtitle')?.textContent || '').trim();
        const loc = (card.querySelector('.job-search-card__location')?.textContent || '').trim();
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
        description: `${j.company} is seeking a ${j.title} on a contract basis.`,
        platform: 'LinkedIn',
        budget: '', skills: extractSkills(j.title), postedAt: '',
        listingUrl: j.href, contactName: j.company,
        location: j.loc || location || '', projectType: 'contract', source: 'linkedin'
      });
    }
  } catch (_) { /* skip */ }
  finally { await ctx.close().catch(() => null); }
  return projects;
}

// ─── 7. Staff augmentation deep web search ───────────────────────────────────

// Only exclude the freelance project marketplaces we already scrape directly
// (don't exclude LinkedIn/Indeed/Seek — those can surface company RFP pages)
const FREELANCE_DOMAINS = /\b(upwork\.com|freelancer\.com|guru\.com|peopleperhour\.com|fiverr\.com|toptal\.com|bark\.com|contra\.com)\b/i;

async function searchStaffAugWeb({ keywords, location, maxResults }) {
  const loc = location || '';
  const yr = CURRENT_YEAR;

  // 3 carefully chosen queries: companies that NEED IT help
  const queries = [
    `"IT staff augmentation" OR "dedicated development team" needed partner ${loc} ${yr}`,
    `"outsource software development" OR "hire development team" project ${loc} ${yr}`,
    `"digital transformation" "technology partner" OR "IT vendor" needed ${loc} ${yr}`
  ].map((q) => q.replace(/\s+/g, ' ').trim());

  const results = await ddgMulti(queries, {
    maxTotal: maxResults, maxQueries: 3,
    filterFn: (r) => !FREELANCE_DOMAINS.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });

  return results.map((r) => ({
    id: makeProjId(),
    title: stripSuffix(r.title) || 'IT Staff Augmentation Opportunity',
    description: r.snippet,
    platform: 'Web',
    budget: extractBudget(r.title + ' ' + r.snippet),
    skills: extractSkills(r.snippet),
    postedAt: '', listingUrl: r.url, contactName: '',
    location: loc, projectType: 'contract', source: 'web_staffaug'
  })).slice(0, maxResults);
}

// ─── 8. RFPs, Tenders & Government ───────────────────────────────────────────

const GOVT_RE = /\.gov\.au|\.gov\.uk|\.gov\.nz|\.gov\.sg|\.gov\.ca|\.gov\b|sam\.gov|tenders\.gov|austender|ted\.europa|find-tender\.service\.gov|sourceau/i;

async function searchRFPsAndTenders({ keywords, location, maxResults }) {
  const loc = location || '';
  const yr = CURRENT_YEAR;

  // 3 targeted queries — most likely to return RFP/tender pages
  const queries = [
    `"request for proposal" "software development" OR "IT services" ${loc} ${yr}`,
    `government tender "IT services" OR "software development" OR "digital transformation" ${loc} ${yr}`,
    `site:tenders.gov.au OR site:sam.gov OR site:find-tender.service.gov.uk software OR technology ${yr}`
  ].map((q) => q.replace(/\s+/g, ' ').trim());

  const results = await ddgMulti(queries, {
    maxTotal: maxResults, maxQueries: 3,
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
      postedAt: '', listingUrl: r.url, contactName: '',
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
    developers:   'software developer web developer full stack',
    devops:       'DevOps cloud engineer infrastructure',
    data:         'data engineer data scientist analytics',
    design:       'UX designer UI designer product design',
    architecture: 'solution architect enterprise architect',
    any:          'IT staff augmentation software development'
  };

  const searchKeywords = keywords || resourceMap[resourceType] || 'IT staff augmentation software development';
  const seenUrls = new Set();

  function emit(proj) {
    if (!proj?.listingUrl || seenUrls.has(proj.listingUrl)) return;
    seenUrls.add(proj.listingUrl);
    onResult(proj);
  }

  // ── Sources that need a browser ──────────────────────────────────────────
  const needBrowser = sources.some((s) => ['upwork', 'freelancer', 'pph', 'guru', 'linkedin'].includes(s));
  const browser = needBrowser ? await launchBrowser() : null;

  try {
    if (sources.includes('reddit') && !isCancelled()) {
      onProgress('Searching Reddit r/forhire for [HIRING] IT posts…');
      const results = await searchReddit({ keywords: searchKeywords, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('upwork') && !isCancelled()) {
      onProgress('Searching Upwork (direct scrape + 5 DDG variations)…');
      const results = await searchUpwork(browser, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    if (sources.includes('freelancer') && !isCancelled()) {
      onProgress('Searching Freelancer (direct scrape + 5 DDG variations)…');
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

    if (sources.includes('linkedin') && !isCancelled()) {
      onProgress('Searching LinkedIn contract jobs…');
      const results = await searchLinkedInContracts(browser, { keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }

    // ── Fetch-only sources (no browser needed) ──────────────────────────────
    if (sources.includes('staffaug') && !isCancelled()) {
      onProgress('Deep web search — companies needing IT teams (10 query variations)…');
      const results = await searchStaffAugWeb({ keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
      results.forEach(emit);
    }

    if (sources.includes('web') && !isCancelled()) {
      onProgress('Searching RFPs, government tenders & procurement (11 query variations)…');
      const results = await searchRFPsAndTenders({ keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
      results.forEach(emit);
    }

  } finally {
    if (browser) await browser.close().catch(() => null);
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
  function setPhase(id, phase) { const j = jobs.get(id); if (j) j.phase = phase; }

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
