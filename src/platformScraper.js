'use strict';
// Authenticated browser-based scraping for Upwork and Fiverr
// Uses Playwright Chromium (already installed for LinkedIn/LeadFinder)

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const fsSync = require('node:fs');
const { execSync } = require('node:child_process');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProjId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Shared browser setup ─────────────────────────────────────────────────────

async function ensureChromium() {
  try {
    const exe = chromium.executablePath();
    if (!fsSync.existsSync(exe)) throw new Error('not found');
  } catch (_) {
    execSync('npx playwright install chromium', {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
      timeout: 180000,
      stdio: 'pipe'
    });
  }
}

function newBrowserContext(browser, extra = {}) {
  return browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ...extra
  });
}

// ─── Upwork authenticated search ──────────────────────────────────────────────

async function scrapeUpworkAuth({ email, password, keywords, location, maxResults }) {
  await ensureChromium();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const projects = [];

  try {
    const context = await newBrowserContext(browser);
    const page = await context.newPage();

    // ── Login ──
    await page.goto('https://www.upwork.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Step 1: email
    const emailInput = page.locator('#login_username, input[name="login[username]"], input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(email);
    await sleep(700);

    // Click "Continue with Email" button
    const continueBtn = page.locator('#login_password_continue, [data-qa="btn-continue"], button:has-text("Continue")').first();
    await continueBtn.click();
    await sleep(2000);

    // Step 2: password
    const passInput = page.locator('#login_password, input[name="login[password]"], input[type="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 10000 });
    await passInput.fill(password);
    await sleep(700);

    // Click "Log In"
    const loginBtn = page.locator('#login_control_continue, [data-qa="btn-auth-login"], button:has-text("Log In")').first();
    await loginBtn.click();
    await sleep(5000);

    const afterUrl = page.url();
    if (
      afterUrl.includes('/login') ||
      afterUrl.includes('/challenge') ||
      afterUrl.includes('/captcha') ||
      afterUrl.includes('/security')
    ) {
      throw new Error(
        `Upwork login did not complete. Current page: ${afterUrl}. ` +
        'Check credentials or complete the security challenge in a browser first.'
      );
    }

    // ── Job search ──
    const q = encodeURIComponent(keywords);
    const loc = location ? `&location=${encodeURIComponent(location)}` : '';
    const searchUrl = `https://www.upwork.com/nx/jobs/search/?q=${q}&sort=recency${loc}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3500);

    // Wait for tiles
    const tileSel = '[data-test="JobTile"], article[class*="job-tile"], section[class*="job-tile"], [data-ev-label="job_posting_tile"]';
    await page.waitForSelector(tileSel, { timeout: 12000 }).catch(() => {});

    const jobs = await page.evaluate(({ tileSel, max }) => {
      const results = [];
      const tiles = [...document.querySelectorAll(tileSel)].slice(0, max * 2);

      for (const tile of tiles) {
        try {
          // Title & URL
          const titleEl = tile.querySelector('[data-test="job-tile-title"] a, h2 a, [class*="title"] a, h3 a');
          const title = titleEl?.textContent?.trim() || '';
          const href = titleEl?.getAttribute('href') || '';
          const url = href.startsWith('http') ? href : `https://www.upwork.com${href}`;

          // Description
          const descEl = tile.querySelector('[data-test="job-tile-description"], [class*="description"], [class*="Summary"]');
          const description = descEl?.textContent?.trim().slice(0, 400) || '';

          // Budget
          const budgetEl = tile.querySelector('[data-test="is-fixed-price"], [class*="budget"], [class*="JobTileDetails"] strong, [data-test="budget"]');
          const budget = budgetEl?.textContent?.trim() || '';

          // Skills
          const skillEls = [...tile.querySelectorAll('.air3-token, [class*="skill-tag"], [data-test="token"], .up-skill-badge')];
          const skills = skillEls.slice(0, 8).map((s) => s.textContent.trim()).filter(Boolean);

          // Posted
          const timeEl = tile.querySelector('time, [data-test="posted-on"], [class*="posted"]');
          const postedAt = timeEl?.textContent?.trim() || '';

          if (title && url) results.push({ title, url, description, budget, skills, postedAt });
        } catch (_) {}
      }
      return results;
    }, { tileSel, max: maxResults });

    for (const job of jobs.slice(0, maxResults)) {
      projects.push({
        id: makeProjId(),
        title: job.title,
        description: job.description,
        platform: 'Upwork',
        budget: job.budget,
        skills: job.skills,
        postedAt: job.postedAt,
        listingUrl: job.url,
        contactName: '',
        location: location || '',
        projectType: (job.budget + job.description).toLowerCase().includes('/hr') ? 'hourly' : 'fixed',
        source: 'upwork_auth'
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return projects;
}

// ─── Fiverr buyer requests ─────────────────────────────────────────────────────
// Buyer requests = clients posting what they need; sellers (like you) can respond.
// Only accessible to logged-in sellers at fiverr.com/requests

async function scrapeFiverrRequests({ email, password, keywords, maxResults }) {
  await ensureChromium();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const requests = [];

  try {
    const context = await newBrowserContext(browser);
    const page = await context.newPage();

    // ── Login ──
    // Fiverr login — try the direct login page
    await page.goto('https://www.fiverr.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    // If redirected to the main page (already logged in?), skip login
    const preLoginUrl = page.url();
    if (!preLoginUrl.includes('/login') && !preLoginUrl.includes('/signup')) {
      // May already be logged in from a cookie
    } else {
      // Try email/password form
      const emailInput = page.locator('input[name="email"], input[type="email"], input[id*="email"]').first();
      const passInput = page.locator('input[name="password"], input[type="password"]').first();

      const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
      if (!emailVisible) {
        // Fiverr may show a tab selection first ("Email")
        const emailTab = page.locator('button:has-text("Email"), [data-testid*="email-tab"], a:has-text("Email")').first();
        if (await emailTab.isVisible({ timeout: 3000 }).catch(() => false)) {
          await emailTab.click();
          await sleep(1000);
        }
      }

      await emailInput.fill(email).catch(() => {});
      await sleep(600);
      await passInput.fill(password).catch(() => {});
      await sleep(600);

      const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Continue"), button:has-text("Log in")').first();
      await submitBtn.click().catch(() => {});
      await sleep(5000);
    }

    const afterUrl = page.url();
    if (afterUrl.includes('/login') || afterUrl.includes('/signup')) {
      throw new Error('Fiverr login did not complete — check your email and password.');
    }

    // ── Buyer requests page ──
    await page.goto('https://www.fiverr.com/requests', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Fiverr may redirect to /requests/all or similar
    const reqUrl = page.url();
    if (reqUrl.includes('/login') || reqUrl.includes('/signup')) {
      throw new Error('Fiverr session expired after navigation — try again.');
    }

    // Wait for request cards
    const cardSel = '[class*="request-row"], [class*="RequestCard"], [data-testid*="request"], li[class*="request"], [class*="buyer-request"]';
    await page.waitForSelector(cardSel, { timeout: 12000 }).catch(() => {});
    await sleep(1500);

    // Keyword filter if search input exists
    const kwInput = page.locator('input[placeholder*="search"], input[placeholder*="filter"]').first();
    if (await kwInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await kwInput.fill(keywords);
      await sleep(2000);
    }

    const reqs = await page.evaluate(({ cardSel, kw, max }) => {
      const results = [];
      const kwLower = kw.toLowerCase();

      // Try multiple selector strategies
      let items = [...document.querySelectorAll(cardSel)];
      if (!items.length) {
        // Fallback: any article/li with "request" in class
        items = [...document.querySelectorAll('article, li')].filter((el) =>
          /request/i.test(el.className) || /buyer/i.test(el.className)
        );
      }

      for (const item of items) {
        if (results.length >= max) break;
        try {
          const allText = item.innerText || '';
          if (!allText.trim()) continue;

          // Keyword filter client-side
          if (kw && !allText.toLowerCase().includes(kwLower.split(' ')[0])) continue;

          const titleEl = item.querySelector('h1, h2, h3, [class*="title"], [class*="header"] > p, strong');
          const title = titleEl?.textContent?.trim().slice(0, 120) || allText.split('\n')[0].trim().slice(0, 120);

          const descEl = item.querySelector('[class*="description"], [class*="desc"], p');
          const description = (descEl?.textContent?.trim() || allText).slice(0, 400);

          const budgetEl = item.querySelector('[class*="budget"], [class*="price"], [class*="amount"]');
          const budget = budgetEl?.textContent?.trim() || '';

          const dateEl = item.querySelector('[class*="date"], [class*="time"], time, [class*="ago"]');
          const postedAt = dateEl?.textContent?.trim() || '';

          const linkEl = item.querySelector('a[href]');
          const href = linkEl?.getAttribute('href') || '';
          const url = href
            ? (href.startsWith('http') ? href : `https://www.fiverr.com${href}`)
            : 'https://www.fiverr.com/requests';

          if (title) results.push({ title, description, budget, postedAt, url });
        } catch (_) {}
      }
      return results;
    }, { cardSel, kw: keywords, max: maxResults });

    for (const req of reqs) {
      if (!req.title) continue;
      requests.push({
        id: makeProjId(),
        title: req.title,
        description: req.description,
        platform: 'Fiverr Requests',
        budget: req.budget,
        skills: [],
        postedAt: req.postedAt,
        listingUrl: req.url,
        contactName: '',
        location: '',
        projectType: 'fixed',
        source: 'fiverr'
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return requests;
}

module.exports = { scrapeUpworkAuth, scrapeFiverrRequests };
