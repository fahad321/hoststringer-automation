'use strict';
// Authenticated browser-based scraping for Upwork and Fiverr
// Supports two login modes:
//   1. Google OAuth  — click "Sign in with Google" on the platform, complete Google login
//   2. Direct        — fill platform email + password directly
// Google mode is tried first when googleEmail + googlePassword are supplied.

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const fsSync = require('node:fs');
const { execSync } = require('node:child_process');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProjId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Chromium setup ───────────────────────────────────────────────────────────

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

function newBrowserContext(browser) {
  return browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
}

// ─── Google OAuth helper ──────────────────────────────────────────────────────
// Call this immediately after the platform redirects to accounts.google.com.
// Fills email + password on Google's OAuth consent page.

async function handleGoogleOAuth(page, { email, password }) {
  // Wait until we're on Google's domain
  await page.waitForURL(/accounts\.google\.com/, { timeout: 20000 }).catch(() => {});
  await sleep(1500);

  const googleUrl = page.url();
  if (!googleUrl.includes('accounts.google.com')) {
    throw new Error(
      `Expected Google login page but landed on: ${googleUrl}. ` +
      'This platform may not support "Sign in with Google".'
    );
  }

  // Google sometimes shows a disabled message for certain OAuth clients
  const disabledText = await page
    .locator('text="Sign in with Google temporarily disabled"')
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (disabledText) {
    throw new Error(
      '"Sign in with Google" is temporarily disabled for this platform\'s app. ' +
      'Use the platform\'s own email/password instead.'
    );
  }

  // ── Email step ──
  const emailInput = page.locator('#identifierId, input[type="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 12000 });
  await emailInput.fill(email);
  await sleep(700);

  // Click "Next" after email
  await page.locator('#identifierNext, button:has-text("Next")').first().click();
  await sleep(2500);

  // Check for "Couldn't find your Google Account"
  const notFound = await page
    .locator('text="Couldn\'t find your Google Account"')
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (notFound) {
    throw new Error('Google account not found — double-check your email address.');
  }

  // ── Password step ──
  const passInput = page.locator('#password input[type="password"], input[type="password"]').first();
  await passInput.waitFor({ state: 'visible', timeout: 12000 });
  await passInput.fill(password);
  await sleep(700);

  // Click "Next" after password
  await page.locator('#passwordNext, button:has-text("Next")').first().click();
  await sleep(4000);

  // Check for wrong-password error
  const wrongPass = await page
    .locator('[class*="error"], text="Wrong password"')
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (wrongPass) {
    throw new Error('Google password is incorrect.');
  }

  // If still on Google after clicking Next, a verification step is blocking us
  const afterUrl = page.url();
  if (afterUrl.includes('accounts.google.com')) {
    const title = await page.title().catch(() => '');
    throw new Error(
      `Google login paused — additional verification required (e.g. 2-step verification, phone prompt). ` +
      `Page title: "${title}". ` +
      `Options: (1) disable Google 2-Step Verification temporarily, ` +
      `(2) use a Google App Password, or ` +
      `(3) use the platform's own email/password credentials instead.`
    );
  }

  // Give the OAuth redirect time to settle
  await sleep(2000);
}

// ─── Upwork authenticated search ──────────────────────────────────────────────
// Params:
//   googleEmail + googlePassword  → click "Continue with Google" on Upwork, complete Google login
//   email + password              → fill Upwork credentials directly

async function scrapeUpworkAuth({
  email, password,
  googleEmail, googlePassword,
  keywords, location, maxResults
}) {
  await ensureChromium();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const projects = [];

  try {
    const context = await newBrowserContext(browser);
    const page = await context.newPage();

    await page.goto('https://www.upwork.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const useGoogle = !!(googleEmail && googlePassword);

    if (useGoogle) {
      // ── Google OAuth login ──
      // Upwork shows "Continue with Google" on its login page
      const googleBtn = page.locator(
        'button:has-text("Continue with Google"), [data-qa="btn-google-auth"], a:has-text("Google"), [aria-label*="Google"]'
      ).first();

      const btnVisible = await googleBtn.isVisible({ timeout: 8000 }).catch(() => false);
      if (!btnVisible) {
        throw new Error(
          'Could not find "Continue with Google" on Upwork\'s login page. ' +
          'Try providing direct Upwork credentials instead.'
        );
      }

      await googleBtn.click();
      await handleGoogleOAuth(page, { email: googleEmail, password: googlePassword });
    } else {
      // ── Direct Upwork login ──
      const emailInput = page.locator('#login_username, input[name="login[username]"], input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(email);
      await sleep(700);

      await page.locator('#login_password_continue, [data-qa="btn-continue"], button:has-text("Continue")').first().click();
      await sleep(2000);

      const passInput = page.locator('#login_password, input[type="password"]').first();
      await passInput.waitFor({ state: 'visible', timeout: 10000 });
      await passInput.fill(password);
      await sleep(700);

      await page.locator('#login_control_continue, [data-qa="btn-auth-login"], button:has-text("Log In")').first().click();
      await sleep(5000);
    }

    // Verify login succeeded
    const afterUrl = page.url();
    if (
      afterUrl.includes('/login') ||
      afterUrl.includes('/challenge') ||
      afterUrl.includes('/captcha') ||
      afterUrl.includes('/security')
    ) {
      throw new Error(
        `Upwork login did not complete (landed on ${afterUrl}). ` +
        'Check credentials or complete any security challenge in a real browser first.'
      );
    }

    // ── Job search ──
    const q = encodeURIComponent(keywords);
    const loc = location ? `&location=${encodeURIComponent(location)}` : '';
    const searchUrl = `https://www.upwork.com/nx/jobs/search/?q=${q}&sort=recency${loc}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3500);

    const tileSel = '[data-test="JobTile"], article[class*="job-tile"], section[class*="job-tile"], [data-ev-label="job_posting_tile"]';
    await page.waitForSelector(tileSel, { timeout: 12000 }).catch(() => {});

    const jobs = await page.evaluate(({ tileSel, max }) => {
      const results = [];
      const tiles = [...document.querySelectorAll(tileSel)].slice(0, max * 2);
      for (const tile of tiles) {
        try {
          const titleEl = tile.querySelector('[data-test="job-tile-title"] a, h2 a, [class*="title"] a, h3 a');
          const title = titleEl?.textContent?.trim() || '';
          const href = titleEl?.getAttribute('href') || '';
          if (!title || !href) continue;
          const url = href.startsWith('http') ? href : `https://www.upwork.com${href}`;
          const descEl = tile.querySelector('[data-test="job-tile-description"], [class*="description"], [class*="Summary"]');
          const description = descEl?.textContent?.trim().slice(0, 400) || '';
          const budgetEl = tile.querySelector('[data-test="is-fixed-price"], [class*="budget"], [data-test="budget"]');
          const budget = budgetEl?.textContent?.trim() || '';
          const skillEls = [...tile.querySelectorAll('.air3-token, [class*="skill-tag"], [data-test="token"], .up-skill-badge')];
          const skills = skillEls.slice(0, 8).map((s) => s.textContent.trim()).filter(Boolean);
          const timeEl = tile.querySelector('time, [data-test="posted-on"], [class*="posted"]');
          const postedAt = timeEl?.textContent?.trim() || '';
          results.push({ title, url, description, budget, skills, postedAt });
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

// ─── Fiverr buyer requests ────────────────────────────────────────────────────
// Buyer Requests = clients posting project briefs; only visible to logged-in sellers.
// Google OAuth is supported: Fiverr shows "Continue with Google" on login.

async function scrapeFiverrRequests({
  email, password,
  googleEmail, googlePassword,
  keywords, maxResults
}) {
  await ensureChromium();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const requests = [];

  try {
    const context = await newBrowserContext(browser);
    const page = await context.newPage();

    await page.goto('https://www.fiverr.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const preLoginUrl = page.url();
    const alreadyLoggedIn = !preLoginUrl.includes('/login') && !preLoginUrl.includes('/signup');

    if (!alreadyLoggedIn) {
      const useGoogle = !!(googleEmail && googlePassword);

      if (useGoogle) {
        // ── Google OAuth login ──
        const googleBtn = page.locator(
          'button:has-text("Continue with Google"), a:has-text("Continue with Google"), [data-testid*="google"], button[aria-label*="Google"]'
        ).first();

        const btnVisible = await googleBtn.isVisible({ timeout: 8000 }).catch(() => false);
        if (!btnVisible) {
          throw new Error(
            'Could not find "Continue with Google" on Fiverr\'s login page. ' +
            'Try providing direct Fiverr credentials instead.'
          );
        }

        await googleBtn.click();
        await handleGoogleOAuth(page, { email: googleEmail, password: googlePassword });
      } else {
        // ── Direct Fiverr login ──
        const emailInput = page.locator('input[name="email"], input[type="email"], input[id*="email"]').first();
        const passInput = page.locator('input[name="password"], input[type="password"]').first();

        // Fiverr sometimes shows a tab selection — click "Email" tab if needed
        const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
        if (!emailVisible) {
          const emailTab = page.locator('button:has-text("Email"), a:has-text("Email")').first();
          if (await emailTab.isVisible({ timeout: 3000 }).catch(() => false)) {
            await emailTab.click();
            await sleep(1000);
          }
        }

        await emailInput.fill(email).catch(() => {});
        await sleep(600);
        await passInput.fill(password).catch(() => {});
        await sleep(600);

        await page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Log in")').first().click().catch(() => {});
        await sleep(5000);
      }

      const afterUrl = page.url();
      if (afterUrl.includes('/login') || afterUrl.includes('/signup')) {
        throw new Error('Fiverr login did not complete — check credentials.');
      }
    }

    // ── Buyer requests page ──
    await page.goto('https://www.fiverr.com/requests', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const reqUrl = page.url();
    if (reqUrl.includes('/login') || reqUrl.includes('/signup')) {
      throw new Error('Fiverr session expired when navigating to requests — try again.');
    }

    // Wait for request cards
    const cardSel = '[class*="request-row"], [class*="RequestCard"], [data-testid*="request"], li[class*="request"], [class*="buyer-request"]';
    await page.waitForSelector(cardSel, { timeout: 12000 }).catch(() => {});
    await sleep(1500);

    // Keyword filter if the search box exists
    const kwInput = page.locator('input[placeholder*="search"], input[placeholder*="filter"]').first();
    if (await kwInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await kwInput.fill(keywords);
      await sleep(2000);
    }

    const reqs = await page.evaluate(({ cardSel, kw, max }) => {
      const results = [];
      const kwLower = kw.toLowerCase();
      let items = [...document.querySelectorAll(cardSel)];
      if (!items.length) {
        items = [...document.querySelectorAll('article, li')].filter((el) =>
          /request|buyer/i.test(el.className || '')
        );
      }
      for (const item of items) {
        if (results.length >= max) break;
        try {
          const allText = item.innerText || '';
          if (!allText.trim()) continue;
          if (kw && !allText.toLowerCase().includes(kwLower.split(' ')[0])) continue;
          const titleEl = item.querySelector('h1, h2, h3, [class*="title"], strong');
          const title = titleEl?.textContent?.trim().slice(0, 120) || allText.split('\n')[0].trim().slice(0, 120);
          const descEl = item.querySelector('[class*="description"], [class*="desc"], p');
          const description = (descEl?.textContent?.trim() || allText).slice(0, 400);
          const budgetEl = item.querySelector('[class*="budget"], [class*="price"], [class*="amount"]');
          const budget = budgetEl?.textContent?.trim() || '';
          const dateEl = item.querySelector('[class*="date"], [class*="time"], time, [class*="ago"]');
          const postedAt = dateEl?.textContent?.trim() || '';
          const linkEl = item.querySelector('a[href]');
          const href = linkEl?.getAttribute('href') || '';
          const url = href ? (href.startsWith('http') ? href : `https://www.fiverr.com${href}`) : 'https://www.fiverr.com/requests';
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
