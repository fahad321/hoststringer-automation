'use strict';
// No browser required — all fetch-based (RSS, Reddit JSON API, Bing, DuckDuckGo HTML)
// DDG: staffaug + RFP only (max ~6 queries/run)
// Bing: Freelancer, PPH, Guru fallback, LinkedIn (separate rate-limiter)
// RSS: Upwork Atom, Guru, We Work Remotely (no rate limit)

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
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function stripSuffix(title) {
  return title
    .replace(/\s*[-–|]\s*(Upwork|Freelancer|PeoplePerHour|Guru|Toptal|Fiverr|LinkedIn|Reddit|Indeed|Seek|Glassdoor|We Work Remotely).*/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'")
    .trim();
}

// ─── DuckDuckGo fetch (GET-based, global rate-limit) ──────────────────────────
// Reserved for staffaug + RFP only — max ~6 queries per run

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

// ─── Bing fetch (separate rate-limiter, higher concurrency) ──────────────────
// Used for Freelancer, PPH, Guru fallback, LinkedIn — avoids DDG exhaustion

const BING_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

let lastBingRequest = 0;

async function bingFetch(query, max = 12) {
  const results = [];
  try {
    const gap = Date.now() - lastBingRequest;
    if (gap < 1500) await sleep(1500 - gap);
    lastBingRequest = Date.now();

    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20`;
    const res = await fetch(url, { headers: BING_HEADERS });
    if (!res.ok) return results;
    const html = await res.text();

    // Each organic result lives inside <li class="b_algo">
    const itemRe = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = itemRe.exec(html)) !== null && results.length < max) {
      const block = m[1];
      // Primary link is always the first <a href> inside an <h2>
      const h2M = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (!h2M) continue;
      const href = h2M[1];
      if (!href || href.includes('bing.com') || href.includes('microsoft.com') || href.includes('msn.com')) continue;
      const title = stripHtml(h2M[2]);
      // Snippet is in a <p> element
      const pM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      const snippet = pM ? stripHtml(pM[1]).slice(0, 400) : '';
      results.push({ title, url: href, snippet });
    }
  } catch (_) {}
  return results;
}

async function bingMulti(queries, { filterFn, maxTotal = 20, maxQueries = 3 } = {}) {
  const seen = new Set();
  const out = [];
  let ran = 0;
  for (const q of queries) {
    if (out.length >= maxTotal || ran >= maxQueries) break;
    const batch = await bingFetch(q, 12);
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

function webToProject(r, platform, source, extra = {}) {
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

// ─── 1. Upwork / Remotive / RemoteOK ─────────────────────────────────────────
// Upwork's public Atom RSS feed was deprecated (HTTP 410 Gone).
// The no-auth fallback now uses two reliable free APIs instead.
// Authenticated Upwork scraping (with credentials) is handled in the orchestrator.

function stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

async function searchUpwork({ keywords, location, maxResults }) {
  const projects = [];
  const seen = new Set();
  const kwWords = keywords.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  function kwMatch(text) {
    if (!kwWords.length) return true;
    const lower = text.toLowerCase();
    return kwWords.some((w) => lower.includes(w));
  }

  // IT-only categories for Remotive (their ?category param is unreliable)
  const REMOTIVE_IT_CATS = /software development|devops|sysadmin|data|design|product|qa|cybersecurity|blockchain|it management/i;
  // Each sub-API gets half the quota so both contribute results
  const halfMax = Math.ceil(maxResults / 2);

  // Primary 1: Remotive API — free, reliable IT remote jobs
  try {
    const res = await fetch('https://remotive.com/api/remote-jobs?category=software-dev&limit=50', {
      headers: { 'User-Agent': 'hoststringer/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      let added = 0;
      for (const job of (data?.jobs || [])) {
        if (added >= halfMax) break;
        if (!job.url || seen.has(job.url)) continue;
        // Category must be IT-related (API sometimes returns non-IT categories)
        if (!REMOTIVE_IT_CATS.test(job.category || '')) continue;
        const text = `${job.title} ${stripHtmlTags(job.description || '')} ${(job.tags || []).join(' ')}`;
        if (!isITRelevant(text)) continue;
        seen.add(job.url);
        added++;
        projects.push({
          id: makeProjId(),
          title: job.title || '',
          description: stripHtmlTags(job.description || '').slice(0, 400),
          platform: 'Remotive',
          budget: '',
          skills: extractSkills(text),
          postedAt: job.publication_date ? new Date(job.publication_date).toLocaleDateString() : '',
          listingUrl: job.url,
          contactName: job.company_name || '',
          location: 'Remote',
          projectType: /contract|freelance/i.test(job.job_type || '') ? 'contract' : 'fixed',
          source: 'remotive'
        });
      }
    }
  } catch (_) {}

  // Primary 2: RemoteOK API — free, dev-tagged jobs (already filtered to dev roles)
  try {
    const res = await fetch('https://remoteok.com/api?tag=dev', {
      headers: { 'User-Agent': 'hoststringer/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      const jobs = Array.isArray(data) ? data.filter((j) => j.id && j.url) : [];
      let added = 0;
      for (const job of jobs) {
        if (added >= halfMax) break;
        if (seen.has(job.url)) continue;
        // tag=dev already filters to dev roles; verify IT signal on title+tags
        const titleTags = `${job.position || ''} ${(job.tags || []).join(' ')}`;
        if (!isITRelevant(titleTags)) continue;
        seen.add(job.url);
        added++;
        projects.push({
          id: makeProjId(),
          title: job.position || '',
          description: stripHtmlTags(job.description || '').slice(0, 400),
          platform: 'RemoteOK',
          budget: job.salary_min ? `$${job.salary_min}–$${job.salary_max || '?'}` : '',
          skills: extractSkills((job.tags || []).join(' ') + ' ' + stripHtmlTags(job.description || '')),
          postedAt: job.date ? new Date(job.date).toLocaleDateString() : '',  // already ISO string
          listingUrl: job.url,
          contactName: job.company || '',
          location: 'Remote',
          projectType: 'contract',
          source: 'remoteok'
        });
      }
    }
  } catch (_) {}

  // Supplemental: Bing site:upwork.com/jobs (works when Bing quota is available)
  if (projects.length < maxResults) {
    const loc = location || '';
    const queries = [
      `site:upwork.com/jobs "${keywords}" ${loc}`.trim(),
      `site:upwork.com/jobs "software development" OR "staff augmentation" ${loc}`.trim()
    ];
    const bingSeen = new Set(projects.map((p) => p.listingUrl));
    const results = await bingMulti(queries, {
      maxTotal: maxResults - projects.length, maxQueries: 2,
      filterFn: (r) => r.url.includes('upwork.com') && isITRelevant(r.title + ' ' + r.snippet)
    });
    for (const r of results) {
      if (!bingSeen.has(r.url)) projects.push(webToProject(r, 'Upwork', 'upwork', { location }));
    }
  }

  return projects.slice(0, maxResults);
}

// ─── 2. Freelancer (Bing site: search) ───────────────────────────────────────
// Freelancer has no public RSS feed — Bing search is the reliable approach

async function searchFreelancer({ keywords, location, maxResults }) {
  const loc = location ? ` ${location}` : '';
  const queries = [
    `site:freelancer.com/projects "${keywords}"${loc}`,
    `site:freelancer.com/projects (software OR web OR mobile OR app OR api OR cloud)${loc}`,
    `site:freelancer.com/projects "software development" OR "web developer"${loc}`
  ];
  const results = await bingMulti(queries, {
    maxTotal: maxResults, maxQueries: 3,
    filterFn: (r) => /freelancer\.com\/(projects?|contest)/.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => webToProject(r, 'Freelancer', 'freelancer', { location })).slice(0, maxResults);
}

// ─── 3. PeoplePerHour (Bing site: search) ────────────────────────────────────

async function searchPeoplePerHour({ keywords, maxResults }) {
  const queries = [
    `site:peopleperhour.com/projects "${keywords}"`,
    `site:peopleperhour.com/projects (software OR web OR mobile OR developer OR engineer)`,
    `site:peopleperhour.com "looking for" (developer OR software OR web OR app)`
  ];
  const results = await bingMulti(queries, {
    maxTotal: maxResults, maxQueries: 3,
    filterFn: (r) => r.url.includes('peopleperhour.com') && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => webToProject(r, 'PeoplePerHour', 'pph')).slice(0, maxResults);
}

// ─── 4. Guru (Bing site: search) ─────────────────────────────────────────────
// Guru removed their public RSS feed (all URL formats return 404).
// Bing site: search is the reliable no-auth approach.

async function searchGuru({ keywords, maxResults }) {
  const queries = [
    `site:guru.com/d/jobs "${keywords}"`,
    `site:guru.com/d/jobs (software OR web OR mobile OR developer OR engineer OR cloud)`,
    `site:guru.com/d/jobs "software development" OR "web developer" OR "app development"`
  ];
  const results = await bingMulti(queries, {
    maxTotal: maxResults, maxQueries: 3,
    filterFn: (r) => /guru\.com\/(d\/jobs|job)/.test(r.url) && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => webToProject(r, 'Guru', 'guru')).slice(0, maxResults);
}

// ─── 5. Reddit (fetch JSON API — no rate limiting) ────────────────────────────

async function searchReddit({ keywords, maxResults }) {
  const projects = [];
  const seen = new Set();
  const subreddits = ['forhire', 'slavelabour', 'entrepreneur', 'techjobs'];

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

// ─── 6. LinkedIn contract jobs (Bing site: search) ────────────────────────────

async function searchLinkedInContracts({ keywords, location, maxResults }) {
  const loc = location ? ` ${location}` : '';
  const queries = [
    `site:linkedin.com/jobs "${keywords}" contract${loc}`,
    `site:linkedin.com/jobs (software OR engineer OR developer) contract remote${loc}`,
    `site:linkedin.com/jobs "staff augmentation" OR "contract developer"${loc}`
  ];
  const results = await bingMulti(queries, {
    maxTotal: maxResults, maxQueries: 3,
    filterFn: (r) => r.url.includes('linkedin.com/jobs') && isITRelevant(r.title + ' ' + r.snippet)
  });
  return results.map((r) => ({
    ...webToProject(r, 'LinkedIn', 'linkedin', { location, projectType: 'contract' }),
    projectType: 'contract'
  })).slice(0, maxResults);
}

// ─── 7. We Work Remotely (RSS feeds) ─────────────────────────────────────────

async function searchWeWorkRemotely({ keywords, maxResults }) {
  const projects = [];
  const seen = new Set();

  const feeds = [
    'https://weworkremotely.com/categories/remote-contract-jobs.rss',
    'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss'
  ];

  const kwWords = keywords.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

  for (const feedUrl of feeds) {
    if (projects.length >= maxResults) break;
    try {
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': DDG_HEADERS['User-Agent'], 'Accept': 'application/rss+xml,*/*' },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml)) !== null && projects.length < maxResults) {
        const item = m[1];
        const title = xmlTag(item, 'title');
        const linkM = /<link[^>]*>\s*(?:<!\[CDATA\[)?(https?:\/\/[^\]<\s]+)/.exec(item)
          || /<link>(https?:\/\/[^<]+)<\/link>/i.exec(item);
        const link = linkM ? linkM[1].trim() : xmlTag(item, 'link');
        const description = xmlTag(item, 'description').slice(0, 400);
        const pubDate = xmlTag(item, 'pubDate');
        if (!title || !link || seen.has(link)) continue;
        const text = title + ' ' + description;
        if (!isITRelevant(text)) continue;
        // Keyword relevance: at least one keyword word appears
        if (kwWords.length > 0 && !kwWords.some((w) => text.toLowerCase().includes(w))) continue;
        seen.add(link);
        projects.push({
          id: makeProjId(),
          title: stripSuffix(title),
          description,
          platform: 'We Work Remotely',
          budget: extractBudget(text),
          skills: extractSkills(text),
          postedAt: pubDate ? new Date(pubDate).toLocaleDateString() : '',
          listingUrl: link,
          contactName: '', location: 'Remote',
          projectType: 'contract',
          source: 'wwr'
        });
      }
    } catch (_) {}
  }
  return projects.slice(0, maxResults);
}

// ─── 8. Staff augmentation deep web search (DDG) ─────────────────────────────
// DDG is now free (freelance platforms use Bing) so we get full quota here

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

// ─── 9. RFPs, Tenders & Government (DDG) ─────────────────────────────────────

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
  credentials = {},
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

  // Reddit — JSON API, no rate limiting, runs first
  if (sources.includes('reddit') && !isCancelled()) {
    onProgress('Searching Reddit r/forhire for [HIRING] IT posts…');
    const results = await searchReddit({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // We Work Remotely — RSS, no rate limiting
  if (sources.includes('wwr') && !isCancelled()) {
    onProgress('Searching We Work Remotely contract jobs…');
    const results = await searchWeWorkRemotely({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // Upwork — authenticated (Google or direct creds) OR RSS + Bing fallback
  if (sources.includes('upwork') && !isCancelled()) {
    const hasGoogleCreds  = !!(credentials.googleEmail && credentials.googlePassword);
    const hasUpworkCreds  = !!(credentials.upworkEmail && credentials.upworkPassword);
    if (hasGoogleCreds || hasUpworkCreds) {
      onProgress('Signing in to Upwork for authenticated job search…');
      try {
        const { scrapeUpworkAuth } = require('./platformScraper');
        const authResults = await scrapeUpworkAuth({
          googleEmail:    credentials.googleEmail,
          googlePassword: credentials.googlePassword,
          email:          credentials.upworkEmail,
          password:       credentials.upworkPassword,
          keywords: searchKeywords, location,
          maxResults: maxPerSource * 2
        });
        authResults.forEach(emit);
        if (authResults.length === 0) {
          // Authenticated but no results — supplement with RSS
          const rssResults = await searchUpwork({ keywords: searchKeywords, location, maxResults: maxPerSource });
          rssResults.forEach(emit);
        }
      } catch (err) {
        onProgress(`Upwork login failed (${err.message}) — falling back to RSS feed…`);
        const results = await searchUpwork({ keywords: searchKeywords, location, maxResults: maxPerSource });
        results.forEach(emit);
      }
    } else {
      onProgress('Searching Upwork job feed…');
      const results = await searchUpwork({ keywords: searchKeywords, location, maxResults: maxPerSource });
      results.forEach(emit);
    }
  }

  // Guru — RSS (primary) then Bing fallback
  if (sources.includes('guru') && !isCancelled()) {
    onProgress('Searching Guru.com listings…');
    const results = await searchGuru({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // Freelancer — Bing site: search (separate engine, no DDG conflict)
  if (sources.includes('freelancer') && !isCancelled()) {
    onProgress('Searching Freelancer.com listings…');
    const results = await searchFreelancer({ keywords: searchKeywords, location, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // PeoplePerHour — Bing site: search
  if (sources.includes('pph') && !isCancelled()) {
    onProgress('Searching PeoplePerHour listings…');
    const results = await searchPeoplePerHour({ keywords: searchKeywords, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // LinkedIn — Bing site: search
  if (sources.includes('linkedin') && !isCancelled()) {
    onProgress('Searching LinkedIn contract jobs…');
    const results = await searchLinkedInContracts({ keywords: searchKeywords, location, maxResults: maxPerSource });
    results.forEach(emit);
  }

  // Fiverr buyer requests — requires credentials (clients post what they need)
  if (sources.includes('fiverr') && !isCancelled()) {
    const hasGoogleCreds  = !!(credentials.googleEmail && credentials.googlePassword);
    const hasFiverrCreds  = !!(credentials.fiverrEmail && credentials.fiverrPassword);
    if (hasGoogleCreds || hasFiverrCreds) {
      onProgress('Signing in to Fiverr to scrape buyer requests…');
      try {
        const { scrapeFiverrRequests } = require('./platformScraper');
        const results = await scrapeFiverrRequests({
          googleEmail:    credentials.googleEmail,
          googlePassword: credentials.googlePassword,
          email:          credentials.fiverrEmail,
          password:       credentials.fiverrPassword,
          keywords: searchKeywords,
          maxResults: maxPerSource
        });
        results.forEach(emit);
      } catch (err) {
        onProgress(`Fiverr scraping failed: ${err.message}`);
      }
    } else {
      onProgress('Fiverr: enter Google or Fiverr credentials in Step 3 to enable buyer requests.');
    }
  }

  // Staff aug deep web — DDG (budget available now that freelance platforms use Bing)
  if (sources.includes('staffaug') && !isCancelled()) {
    onProgress('Deep web search — companies needing IT teams…');
    const results = await searchStaffAugWeb({ keywords: searchKeywords, location, maxResults: maxPerSource * 2 });
    results.forEach(emit);
  }

  // RFPs & Government — DDG
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
