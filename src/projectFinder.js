'use strict';
// No browser required — all fetch-based (RSS, Reddit JSON API, DuckDuckGo HTML)

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

const IT_SIGNAL = /\b(software|developer|engineer|devops|cloud|api|app|application|platform|system|database|backend|frontend|fullstack|mobile|web|tech(?:nology)?|IT|digital|data|saas|infrastructure|microservice|qa|testing|react|angular|vue|node|python|java|php|aws|azure|gcp|kubernetes|docker|blockchain|cybersecurity|programmer|coding|coder)\b/i;

function isITRelevant(text) { return IT_SIGNAL.test(text); }

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function stripSuffix(title) {
  return title
    .replace(/\s*[-–|]\s*(Upwork|Freelancer|PeoplePerHour|Guru|Toptal|Fiverr|LinkedIn|Reddit|Indeed|Seek|Glassdoor).*/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'")
    .trim();
}

// ─── DuckDuckGo fetch (GET-based, no browser, global rate-limit) ──────────────
// DDG rate-limits after ~3 rapid consecutive requests.
// Strategy: GET (not POST), ≥3.2 s between all DDG calls, ≤3 queries per source.

const DDG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://duckduckgo.com/'
};

let lastDdgRequest = 0;

async function ddgFetch(query, max = 12) {
  const results = [];
  try {
    const gap = Date.now() - lastDdgRequest;
    if (gap < 3200) await sleep(3200 - gap);
    lastDdgRequest = Date.now();

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=en-us`;
    const res = await fetch(url, { headers: DDG_HEADERS });
    if (!res.ok) return results;
    const html = await res.text();
    if (!html.includes('result__a')) return results;

    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const urls = [], titles = [], snippets = [];
    let m;
    while ((m = linkRe.exec(html)) !== null && urls.length < max + 5) {
      const u = m[1];
      if (!u || u.includes('duckduckgo')) continue;
      urls.push(u);
      titles.push(stripHtml(m[2]));
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < max + 5) {
      snippets.push(stripHtml(m[1]).slice(0, 400));
    }
    for (let i = 0; i < Math.min(urls.length, max); i++) {
      results.push({ title: titles[i] || '', url: urls[i], snippet: snippets[i] || '' });
    }
  } catch (_) {}
  return results;
}

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

// ─── XML/Atom helpers ─────────────────────────────────────────────────────────

function xmlTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  if (!m) return '';
  return stripHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

function xmlAttr(xml, tag, attr) {
  const m = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`, 'i').exec(xml);
  return m ? m[1] : '';
}

// ─── 1. Upwork (Atom RSS feed + DDG fallback) ─────────────────────────────────

async function searchUpwork({ keywords, location, maxResults }) {
  const projects = [];

  // Primary: Upwork public Atom job feed
  try {
    const q = encodeURIComponent(keywords);
    const feedUrl = `https://www.upwork.com/ab/feed/jobs/atom?q=${q}&sort=recency&paging=0%3B25`;
    const res = await fetch(feedUrl, {
      headers: {
        'User-Agent': DDG_HEADERS['User-Agent'],
        'Accept': 'application/atom+xml,application/xml,text/xml,*/*'
      }
    });
    if (res.ok) {
      const xml = await res.text();
      const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = entryRe.exec(xml)) !== null && projects.length < maxResults) {
        const entry = m[1];
        const title = xmlTag(entry, 'title');
        const link = xmlAttr(entry, 'link', 'href') || xmlTag(entry, 'id');
        const summary = xmlTag(entry, 'summary').slice(0, 400);
        const updated = xmlTag(entry, 'updated');
        if (!title || !link) continue;
        const text = title + ' ' + summary;
        if (!isITRelevant(text)) continue;
        projects.push({
          id: makeProjId(),
          title: stripSuffix(title),
          description: summary,
          platform: 'Upwork',
          budget: extractBudget(text),
          skills: extractSkills(text),
          postedAt: updated ? new Date(updated).toLocaleDateString() : '',
          listingUrl: link,
          contactName: '', location: location || '',
          projectType: summary.toLowerCase().includes('/hr') ? 'hourly' : 'fixed',
          source: 'upwork'
        });
      }
    }
  } catch (_) {}

  // Fallback: DDG site: search
  if (projects.length < maxResults) {
    const queries = [
      `site:upwork.com/jobs "${keywords}" ${location || ''}`.trim(),
      `site:upwork.com/jobs "staff augmentation" OR "software development" ${location || ''}`.trim()
    ];
    const seen = new Set(projects.map((p) => p.listingUrl));
    const results = await ddgMulti(queries, {
      maxTotal: maxResults - projects.length, maxQueries: 2,
      filterFn: (r) => r.url.includes('upwork.com') && isITRelevant(r.title + ' ' + r.snippet)
    });
    for (const r of results) {
      if (!seen.has(r.url)) projects.push(ddgToProject(r, 'Upwork', 'upwork', { location }));
    }
  }
  return projects.slice(0, maxResults);
}

// ─── 2. Freelancer (DDG site: search) ────────────────────────────────────────

async function searchFreelancer({ keywords, location, maxResults }) {
  const queries = [
    `site:freelancer.com/projects "${keywords}" ${location || ''}`.trim(),
    `site:freelancer.com/projects "software development" OR "web application" ${location || ''}`.trim()
  ];
  const results = await ddgMulti(queries, {
    maxTotal: maxResults, maxQueries: 2,
    filterFn: (r) => /freelancer\.com\/(projects?|contest)/.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => ddgToProject(r, 'Freelancer', 'freelancer', { location })).slice(0, maxResults);
}

// ─── 3. PeoplePerHour (DDG site: search) ─────────────────────────────────────

async function searchPeoplePerHour({ keywords, maxResults }) {
  const queries = [
    `site:peopleperhour.com "${keywords}"`,
    `site:peopleperhour.com "software development" OR "web development" OR "mobile app"`
  ];
  const results = await ddgMulti(queries, {
    maxTotal: maxResults, maxQueries: 2,
    filterFn: (r) => r.url.includes('peopleperhour.com') && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => ddgToProject(r, 'PeoplePerHour', 'pph')).slice(0, maxResults);
}

// ─── 4. Guru (DDG site: search) ──────────────────────────────────────────────

async function searchGuru({ keywords, maxResults }) {
  const queries = [
    `site:guru.com/d/jobs "${keywords}"`,
    `site:guru.com/d/jobs "software development" OR "web development"`
  ];
  const results = await ddgMulti(queries, {
    maxTotal: maxResults, maxQueries: 2,
    filterFn: (r) => /guru\.com\/(d\/jobs|job)/.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => ddgToProject(r, 'Guru', 'guru')).slice(0, maxResults);
}

// ─── 5. Reddit (fetch JSON API — no rate limiting) ────────────────────────────

async function searchReddit({ keywords, maxResults }) {
  const projects = [];
  const seen = new Set();
  const subreddits = ['forhire', 'slavelabour', 'entrepreneur'];

  const headers = {
    'User-Agent': 'hoststringer-bot/1.0 (IT consultancy lead finder)',
    'Accept': 'application/json'
  };

  for (const sub of subreddits) {
    if (projects.length >= maxResults) break;
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent('[HIRING] ' + keywords)}&restrict_sr=1&sort=new&limit=30&t=month`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();

      for (const child of (data?.data?.children || [])) {
        if (projects.length >= maxResults) break;
        const post = child.data;
        if (!post?.title) continue;

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
    } catch (_) {}
    await jitter(400, 200);
  }
  return projects;
}

// ─── 6. LinkedIn contract jobs (DDG site: search) ────────────────────────────

async function searchLinkedInContracts({ keywords, location, maxResults }) {
  const loc = location || '';
  const queries = [
    `site:linkedin.com/jobs "${keywords}" contract ${loc}`.trim(),
    `site:linkedin.com/jobs "software developer" OR "engineer" contract ${loc}`.trim()
  ];
  const results = await ddgMulti(queries, {
    maxTotal: maxResults, maxQueries: 2,
    filterFn: (r) => r.url.includes('linkedin.com/jobs') && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => ({
    ...ddgToProject(r, 'LinkedIn', 'linkedin', { location, projectType: 'contract' }),
    projectType: 'contract'
  })).slice(0, maxResults);
}

// ─── 7. Staff augmentation deep web search ───────────────────────────────────

// Exclude the freelance project marketplaces we search directly
const FREELANCE_DOMAINS = /\b(upwork\.com|freelancer\.com|guru\.com|peopleperhour\.com|fiverr\.com|toptal\.com|bark\.com|contra\.com)\b/i;

async function searchStaffAugWeb({ keywords, location, maxResults }) {
  const loc = location || '';
  const yr = CURRENT_YEAR;

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

  // Reddit first — no rate limiting, fast
  if (sources.includes('reddit') && !isCancelled()) {
    onProgress('Searching Reddit r/forhire for [HIRING] IT posts…');
    const results = await searchReddit({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // Upwork via RSS feed (fast, reliable) — no DDG quota used
  if (sources.includes('upwork') && !isCancelled()) {
    onProgress('Searching Upwork job feed…');
    const results = await searchUpwork({ keywords: searchKeywords, location, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // DDG-based sources — each respects the 3.2 s gap via shared lastDdgRequest
  if (sources.includes('freelancer') && !isCancelled()) {
    onProgress('Searching Freelancer.com listings…');
    const results = await searchFreelancer({ keywords: searchKeywords, location, maxResults: maxPerSource });
    results.forEach(emit);
  }

  if (sources.includes('pph') && !isCancelled()) {
    onProgress('Searching PeoplePerHour listings…');
    const results = await searchPeoplePerHour({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  if (sources.includes('guru') && !isCancelled()) {
    onProgress('Searching Guru.com listings…');
    const results = await searchGuru({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  if (sources.includes('linkedin') && !isCancelled()) {
    onProgress('Searching LinkedIn contract jobs…');
    const results = await searchLinkedInContracts({ keywords: searchKeywords, location, maxResults: maxPerSource });
    results.forEach(emit);
  }

  if (sources.includes('staffaug') && !isCancelled()) {
    onProgress('Deep web search — companies needing IT teams…');
    const results = await searchStaffAugWeb({ keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
    results.forEach(emit);
  }

  if (sources.includes('web') && !isCancelled()) {
    onProgress('Searching RFPs, government tenders & procurement…');
    const results = await searchRFPsAndTenders({ keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
    results.forEach(emit);
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
