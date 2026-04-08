const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { normalizeRow, renderTemplate } = require('./template');

const LINKEDIN_URL_CANDIDATES = [
  'person_linkedin_url',
  'linkedin_url',
  'linkedin_profile_url',
  'linkedin',
  'profile_url',
  'personlinkedinurl'
];
const PROFILE_ACTION_QUERY = 'main button, main a, main [role="button"]';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'lead';
}

async function collectMenuLabels(page) {
  return page.evaluate(() => {
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    };

    const roots = [
      ...document.querySelectorAll('[role="menu"], .artdeco-dropdown__content, .artdeco-popover__content')
    ].filter(isVisible);

    const labels = [];
    for (const root of roots) {
      const nodes = [...root.querySelectorAll('button, [role="menuitem"], [role="button"], a, li, div')];
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const label = normalize(node.getAttribute('aria-label') || node.textContent);
        if (!label) continue;
        labels.push(label);
        if (labels.length >= 40) return labels;
      }
    }
    return labels;
  });
}

async function captureDebugScreenshot(page, artifactsDir, lead, suffix) {
  if (!artifactsDir) return null;
  const slug = safeSlug(lead.receiver_name || lead.linkedin_url);
  const file = path.join(
    artifactsDir,
    `${Date.now()}-${slug}-${suffix}.png`
  );
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (_error) {
    return null;
  }
}

async function clearPotentialOverlays(page) {
  try {
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  } catch (_error) {
    // ignore
  }
}

async function closeBlockingDialogs(page) {
  const closePatterns = [/^Close$/i, /^Done$/i, /^Dismiss$/i, /^Cancel$/i];
  const premiumModal = page.locator('[role="dialog"]').filter({
    hasText: /Send unlimited personalized invites with Premium|personalize every connection request/i
  }).first();
  if (await premiumModal.count()) {
    const premiumClose = premiumModal.locator(
      'button[aria-label*="Close"], button[aria-label*="Dismiss"], button'
    ).first();
    if (await premiumClose.count()) {
      await robustClick(page, premiumClose).catch(() => null);
      await page.waitForTimeout(250);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(250);
    return true;
  }

  for (const pattern of closePatterns) {
    const btn = page.locator('[role="dialog"] button').filter({ hasText: pattern }).first();
    if (await btn.count()) {
      await robustClick(page, btn).catch(() => null);
      await page.waitForTimeout(250);
      return true;
    }
  }

  const genericClose = page
    .locator('[role="dialog"] button[aria-label*="Close"], [role="dialog"] button[aria-label*="Dismiss"]')
    .first();
  if (await genericClose.count()) {
    await robustClick(page, genericClose).catch(() => null);
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}

async function openProfileWithAuthHandling(page, linkedinUrl) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(linkedinUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const currentUrl = page.url();
      const redirectedToAuthwall = /seo-authwall-base_sign-in-submit|\/authwall/i.test(message)
        || /seo-authwall-base_sign-in-submit|\/authwall/i.test(currentUrl);
      if (!redirectedToAuthwall) {
        throw error;
      }
      await waitForLinkedinLogin(page);
      await page.waitForTimeout(1200);
    }
  }
  throw lastError || new Error('Unable to open LinkedIn profile.');
}

async function robustClick(page, locator, options = {}) {
  const dismissOverlays = Boolean(options.dismissOverlays);
  const target = locator.first();
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (dismissOverlays) {
        await clearPotentialOverlays(page);
      }
      await target.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      await target.click({ timeout: 6000 });
      return;
    } catch (error) {
      lastError = error;
      try {
        await target.click({ timeout: 4000, force: true });
        return;
      } catch (forceError) {
        lastError = forceError;
        try {
          await target.evaluate((el) => el.click());
          return;
        } catch (evalError) {
          lastError = evalError;
          await page.waitForTimeout(300);
        }
      }
    }
  }

  throw lastError || new Error('Click failed.');
}

async function domFindAndClickInviteAction(dialog) {
  return dialog.evaluate((root) => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const score = (label) => {
      const text = String(label || '').trim().toLowerCase();
      if (!text) return -100;
      if (/(cancel|close|dismiss|back|not now|skip)/i.test(text)) return -100;
      if (/send without a note/i.test(text)) return 120;
      if (/send invitation|send invite/i.test(text)) return 110;
      if (/^send$/i.test(text)) return 100;
      if (/invite|invitation/i.test(text)) return 90;
      if (/done|next|continue|submit/i.test(text)) return 60;
      return 0;
    };

    const buttons = [...root.querySelectorAll('button')].filter(isVisible);
    const candidates = buttons.map((button) => {
      const label = (button.getAttribute('aria-label') || button.innerText || '').trim();
      return { button, label, score: score(label) };
    });

    const best = candidates
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)[0];

    if (!best) {
      return {
        clicked: false,
        labels: candidates.map((c) => c.label).filter(Boolean).slice(0, 20)
      };
    }

    best.button.click();
    return { clicked: true, label: best.label };
  });
}

async function confirmInvitationSent(page, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pendingBtn = await findVisibleByNames(page, ['Pending']);
    if (pendingBtn) {
      return { ok: true, evidence: 'Pending button visible' };
    }

    const toast = page
      .locator('[role="alert"], [role="status"], .artdeco-toast-item')
      .filter({ hasText: /invitation sent|invite sent|pending/i })
      .first();
    if (await toast.count()) {
      return { ok: true, evidence: 'LinkedIn toast confirmation visible' };
    }

    await page.waitForTimeout(800);
  }

  return { ok: false, evidence: 'No pending state or confirmation toast detected' };
}

async function sendConnectionRequestWithoutNote(page) {
  const directBtn = page.getByRole('button', { name: /Send without a note/i }).first();
  if (await directBtn.count()) {
    await robustClick(page, directBtn);
    return confirmInvitationSent(page);
  }

  // Try backing out from note dialog to reach the base connect surface.
  const closeBtn = page.locator(
    '[role="dialog"] button[aria-label*="Close"], [role="dialog"] button[aria-label*="Dismiss"], [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("Cancel")'
  ).first();
  if (await closeBtn.count()) {
    await robustClick(page, closeBtn).catch(() => null);
    await page.waitForTimeout(400);
  }

  const secondTryBtn = page.getByRole('button', { name: /Send without a note/i }).first();
  if (await secondTryBtn.count()) {
    await robustClick(page, secondTryBtn);
    return confirmInvitationSent(page);
  }

  return { ok: false, evidence: 'No "Send without a note" action available after fallback.' };
}

async function attemptNoNoteFallbackFromDialog({ page, addDebug }) {
  await addDebug('attempt_no_note_fallback_from_dialog');
  const closedDialog = await closeBlockingDialogs(page);
  if (closedDialog) {
    await addDebug('attempt_no_note_closed_blocking_dialog');
  }
  const fallbackConfirmation = await sendConnectionRequestWithoutNote(page);
  await addDebug('attempt_no_note_fallback_result', {
    ok: fallbackConfirmation.ok,
    evidence: fallbackConfirmation.evidence
  });
  return fallbackConfirmation;
}

async function fillMessageInput(inputLocator, text) {
  const safeText = String(text || '');
  const tag = await inputLocator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'textarea') {
    await inputLocator.click().catch(() => null);
    await inputLocator.fill(safeText).catch(() => null);
    const current = await readMessageInput(inputLocator);
    if (!current || !current.includes(safeText.slice(0, 10))) {
      await inputLocator.click().catch(() => null);
      await inputLocator.press('Meta+A').catch(() => null);
      await inputLocator.press('Control+A').catch(() => null);
      await inputLocator.press('Backspace').catch(() => null);
      await inputLocator.type(safeText, { delay: 12 }).catch(() => null);
    }
    return tag;
  }

  await inputLocator.click().catch(() => null);
  await inputLocator.press('Meta+A').catch(() => null);
  await inputLocator.press('Control+A').catch(() => null);
  await inputLocator.press('Backspace').catch(() => null);

  // Prefer real typing events because LinkedIn composers often ignore raw textContent mutation.
  await inputLocator.type(safeText, { delay: 10 }).catch(() => null);

  let current = await readMessageInput(inputLocator);
  if (!current || !current.includes(safeText.slice(0, 10))) {
    await inputLocator.fill(safeText).catch(() => null);
    current = await readMessageInput(inputLocator);
  }
  if (!current || !current.includes(safeText.slice(0, 10))) {
    await inputLocator.evaluate((el, value) => {
      const node = el;
      node.textContent = value;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'g' }));
    }, safeText).catch(() => null);
  }
  return tag || 'contenteditable';
}

async function readMessageInput(inputLocator) {
  return inputLocator.evaluate((el) => {
    const node = el;
    if (node.tagName.toLowerCase() === 'textarea') {
      return String(node.value || '').trim();
    }
    return String(node.textContent || '').trim();
  }).catch(() => '');
}

async function confirmDirectMessageSent(page, messageInputLocator, originalMessage, timeoutMs = 12000) {
  const startedAt = Date.now();
  const probe = String(originalMessage || '').slice(0, 30).toLowerCase();

  while (Date.now() - startedAt < timeoutMs) {
    const toast = page
      .locator('[role="alert"], [role="status"], .artdeco-toast-item')
      .filter({ hasText: /message sent|sent/i })
      .first();
    if (await toast.count()) {
      return { ok: true, evidence: 'LinkedIn toast confirmation visible' };
    }

    if (await messageInputLocator.count()) {
      const current = (await readMessageInput(messageInputLocator)).toLowerCase();
      if (!current || (probe && !current.includes(probe))) {
        return { ok: true, evidence: 'Message composer cleared/changed after send' };
      }
    }

    await page.waitForTimeout(600);
  }

  return { ok: false, evidence: 'No direct message confirmation was detected.' };
}

async function sendDirectMessageToConnection({
  page,
  messageButton,
  dmTemplate,
  lead,
  addDebug
}) {
  const rendered = renderTemplate(dmTemplate, lead).trim().slice(0, 300);
  if (!rendered) {
    throw new Error('DM template rendered empty text for this lead.');
  }

  async function firstVisibleFromSelectors(selectors, maxPerSelector = 6) {
    for (const selector of selectors) {
      const group = page.locator(selector);
      const total = await group.count();
      if (!total) continue;
      const capped = Math.min(total, maxPerSelector);
      for (let i = 0; i < capped; i += 1) {
        const candidate = group.nth(i);
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) return candidate;
      }
    }
    return null;
  }

  async function findMessageInput() {
    return firstVisibleFromSelectors([
      '[role="dialog"] [contenteditable="true"][role="textbox"]',
      '[role="dialog"] .msg-form__contenteditable',
      '[role="dialog"] textarea',
      '.msg-overlay-bubble-header + .msg-form [contenteditable="true"][role="textbox"]',
      '.msg-overlay-conversation-bubble [contenteditable="true"][role="textbox"]',
      '.msg-overlay-conversation-bubble textarea',
      '.msg-form__msg-content-container [contenteditable="true"]',
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form__contenteditable',
      '[data-view-name*="message"] [contenteditable="true"][role="textbox"]',
      '[data-view-name*="message"] textarea',
      '[aria-label*="Write a message"]',
      '[placeholder*="Write a message"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea'
    ]);
  }

  await robustClick(page, messageButton, { dismissOverlays: true });
  await page.waitForTimeout(700);
  await addDebug('dm_opened_from_profile_button', { pageUrl: page.url() });

  let messageInput = await findMessageInput();
  if (!messageInput) {
    await addDebug('dm_message_input_not_found_retry_click');
    await robustClick(page, messageButton, { dismissOverlays: true }).catch(() => null);
    await page.waitForTimeout(700);
    messageInput = await findMessageInput();
  }
  if (!messageInput) {
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(300);
    await robustClick(page, messageButton, { dismissOverlays: true }).catch(() => null);
    await page.waitForTimeout(900);
    messageInput = await findMessageInput();
    await addDebug('dm_message_input_retry_after_escape', { pageUrl: page.url() });
  }
  if (!messageInput) {
    const messageLabels = await page.evaluate(() => {
      const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      };
      return [...document.querySelectorAll('button, [role="button"], a')]
        .filter(isVisible)
        .map((node) => normalize(node.getAttribute('aria-label') || node.textContent))
        .filter(Boolean)
        .filter((label) => /message|inmail|send/i.test(label))
        .slice(0, 20);
    }).catch(() => []);
    await addDebug('dm_message_input_not_found_after_retry', {
      pageUrl: page.url(),
      messageLabels
    });
    return { ok: false, evidence: 'Unable to find message input after clicking Message.' };
  }

  const inputTag = await fillMessageInput(messageInput, rendered);
  await addDebug('dm_filled', { length: rendered.length, tag: inputTag || 'unknown' });

  const sendBtn = await firstVisibleFromSelectors([
    '[role="dialog"] button:has-text("Send")',
    '[role="dialog"] button[aria-label*="Send"]',
    '.msg-form__send-button',
    '.msg-overlay-conversation-bubble button[aria-label*="Send"]',
    '.msg-overlay-conversation-bubble button:has-text("Send")',
    'button[data-control-name*="send"]',
    'button[aria-label*="Send message"]',
    'button:has-text("Send")'
  ], 10);

  if (!sendBtn) {
    await page.keyboard.press('Control+Enter').catch(() => null);
    await page.waitForTimeout(700);
    const keyConfirmation = await confirmDirectMessageSent(page, messageInput, rendered, 5000);
    if (keyConfirmation.ok) {
      return { ok: true, evidence: `Sent via keyboard shortcut (${keyConfirmation.evidence})` };
    }
    return { ok: false, evidence: 'Unable to find Send button in LinkedIn DM composer.' };
  }

  const sendDisabled = await sendBtn.evaluate((el) => {
    const node = el;
    return Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true');
  }).catch(() => false);
  if (sendDisabled) {
    await addDebug('dm_send_disabled_retry_input_activation');
    await messageInput.click().catch(() => null);
    await page.keyboard.type(' ', { delay: 20 }).catch(() => null);
    await page.keyboard.press('Backspace').catch(() => null);
    await page.waitForTimeout(250);

    const stillDisabled = await sendBtn.evaluate((el) => {
      const node = el;
      return Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true');
    }).catch(() => false);

    if (!stillDisabled) {
      await robustClick(page, sendBtn);
      await addDebug('dm_send_button_clicked_after_retry');
      const retryConfirmation = await confirmDirectMessageSent(page, messageInput, rendered);
      if (retryConfirmation.ok) {
        return { ok: true, evidence: retryConfirmation.evidence };
      }
    }

    await page.keyboard.press('Control+Enter').catch(() => null);
    await page.waitForTimeout(700);
    const keySendConfirmation = await confirmDirectMessageSent(page, messageInput, rendered, 5000);
    if (keySendConfirmation.ok) {
      return { ok: true, evidence: `Sent via keyboard shortcut (${keySendConfirmation.evidence})` };
    }

    return { ok: false, evidence: 'DM Send button is disabled. Message input was not accepted by LinkedIn composer.' };
  }

  await robustClick(page, sendBtn);
  await addDebug('dm_send_button_clicked');

  const confirmation = await confirmDirectMessageSent(page, messageInput, rendered);
  if (!confirmation.ok) {
    return { ok: false, evidence: `DM send was clicked but not confirmed. ${confirmation.evidence}` };
  }

  return { ok: true, evidence: confirmation.evidence };
}

async function waitForConnectSurface(page, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pendingBtn = await findVisibleByNames(page, ['Pending']);
    if (pendingBtn) {
      return { type: 'pending' };
    }

    const dialog = page.locator('[role="dialog"]').last();
    const dialogCount = await dialog.count();
    if (dialogCount > 0) {
      return { type: 'dialog', dialog };
    }

    const addNoteBtn = page.getByRole('button', { name: /Add a note|Add note/i }).first();
    if (await addNoteBtn.count()) {
      return { type: 'add_note_inline' };
    }

    const sendWithoutNoteBtn = page
      .getByRole('button', { name: /Send without a note/i })
      .first();
    if (await sendWithoutNoteBtn.count()) {
      return { type: 'send_without_note_inline' };
    }

    const toast = page
      .locator('[role="alert"], [role="status"], .artdeco-toast-item')
      .filter({ hasText: /invitation sent|invite sent|pending/i })
      .first();
    if (await toast.count()) {
      return { type: 'toast' };
    }

    await page.waitForTimeout(500);
  }

  return { type: 'none' };
}

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tokenizeName(value) {
  return String(value || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

function extractLinkedinSlug(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).toLowerCase() : '';
  } catch (_error) {
    return '';
  }
}

function isLikelySameProfileSlug(expectedSlug, actualSlug) {
  if (!expectedSlug || !actualSlug) return true;
  if (expectedSlug === actualSlug) return true;

  const splitTokens = (slug) => slug
    .split('-')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  const expectedTokens = splitTokens(expectedSlug);
  const actualTokens = splitTokens(actualSlug);
  if (!expectedTokens.length || !actualTokens.length) return false;
  const overlap = expectedTokens.filter((token) => actualTokens.includes(token));
  return overlap.length >= Math.min(2, expectedTokens.length, actualTokens.length);
}

async function collectProfileActionSnapshot(page) {
  return page.evaluate((selector) => {
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    };

    const main = document.querySelector('main');
    if (!main) {
      return {
        pageUrl: window.location.href,
        pageTitle: document.title || '',
        headingText: '',
        headingCandidates: [],
        zone: null,
        actions: [],
        allMainActionLabels: []
      };
    }

    const headingCandidates = [
      ...main.querySelectorAll(
        'h1, [data-anonymize="person-name"], .text-heading-xlarge, .inline.t-24, .pv-text-details__left-panel h1'
      )
    ]
      .filter(isVisible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          text: normalize(node.textContent),
          top: rect.top,
          left: rect.left,
          bottom: rect.bottom
        };
      })
      .filter((item) => item.text)
      .sort((a, b) => (a.top - b.top) || (a.left - b.left));

    const heading = headingCandidates[0] || null;
    const headingRect = heading
      ? {
          top: heading.top,
          left: heading.left,
          bottom: heading.bottom
        }
      : null;

    const zone = headingRect
      ? {
          minTop: Math.max(-20, headingRect.top - 20),
          maxTop: Math.min(window.innerHeight + 320, headingRect.bottom + 300),
          minLeft: Math.max(0, headingRect.left - 40),
          maxLeft: Math.max(420, Math.min(window.innerWidth - 220, headingRect.left + 760))
        }
      : {
          minTop: 80,
          maxTop: Math.min(window.innerHeight + 260, 820),
          minLeft: 0,
          maxLeft: Math.max(420, Math.min(window.innerWidth - 220, 920))
        };

    const queryNodes = [...document.querySelectorAll(selector)];
    const actions = queryNodes
      .map((node, queryIndex) => {
        if (!main.contains(node) || !isVisible(node)) return null;
        const rect = node.getBoundingClientRect();
        const text = normalize(node.textContent);
        const aria = normalize(node.getAttribute('aria-label'));
        const label = aria || text;
        if (!label) return null;
        return {
          queryIndex,
          tag: node.tagName.toLowerCase(),
          text,
          aria,
          label,
          top: rect.top,
          left: rect.left,
          width: rect.width
        };
      })
      .filter(Boolean);

    const profileActions = actions
      .filter((item) => (
        item.top >= zone.minTop &&
        item.top <= zone.maxTop &&
        item.left >= zone.minLeft &&
        item.left <= zone.maxLeft
      ))
      .sort((a, b) => (a.top - b.top) || (a.left - b.left))
      .slice(0, 80);

    return {
      pageUrl: window.location.href,
      pageTitle: document.title || '',
      headingText: heading ? heading.text : '',
      headingCandidates: headingCandidates.slice(0, 6),
      zone,
      actions: profileActions,
      allMainActionLabels: actions.slice(0, 40).map((item) => item.label)
    };
  }, PROFILE_ACTION_QUERY);
}

function matchesNamedAction(candidate, names) {
  const variants = [
    normalizeInlineText(candidate.label).toLowerCase(),
    normalizeInlineText(candidate.text).toLowerCase(),
    normalizeInlineText(candidate.aria).toLowerCase()
  ].filter(Boolean);
  const targets = names.map((name) => normalizeInlineText(name).toLowerCase());
  return targets.some((name) => variants.some((variant) => variant === name || variant.startsWith(`${name} `)));
}

async function collectMainActionLabels(page) {
  const snapshot = await collectProfileActionSnapshot(page).catch(() => null);
  if (snapshot?.actions?.length) {
    return snapshot.actions.map((item) => item.label).slice(0, 20);
  }
  const fallback = await page.evaluate(() => {
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('main button, main a, main [role="button"]')]
      .map((node) => normalize(node.getAttribute('aria-label') || node.textContent))
      .filter(Boolean)
      .slice(0, 20);
  }).catch(() => []);
  return Array.isArray(fallback) ? fallback : [];
}

async function findProfilePrimaryConnectButton(
  page,
  receiverName = '',
  profileNameTokens = [],
  providedSnapshot = null
) {
  const receiverTokens = tokenizeName(receiverName);
  const safeTokens = Array.isArray(profileNameTokens) && profileNameTokens.length
    ? profileNameTokens
    : receiverTokens;
  const snapshot = providedSnapshot || await collectProfileActionSnapshot(page);
  const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];

  const scored = actions
    .map((action) => {
      const combined = `${action.label} ${action.text} ${action.aria}`.toLowerCase();
      let score = 0;
      let connectSignal = false;

      if (/^\+?\s*connect$/i.test(action.text) || /^\+?\s*connect$/i.test(action.label)) {
        score += 320;
        connectSignal = true;
      }
      if (/invite .* to connect/i.test(combined)) {
        score += 240;
        connectSignal = true;
      }
      if (/\bconnect\b/i.test(combined)) {
        score += 120;
        connectSignal = true;
      }
      if (/(follow|message|report|block|share|save|privacy|terms|subscribe)/i.test(combined)) score -= 320;

      const tokenHits = safeTokens.filter((token) => combined.includes(token)).length;
      if (tokenHits > 0 && connectSignal) {
        score += 140 + (tokenHits * 20);
      } else if (connectSignal && /invite .* to connect/i.test(combined)) {
        score -= 220;
      }

      if (!connectSignal) {
        return { ...action, score: -999 };
      }
      return { ...action, score };
    })
    .filter((item) => item.score >= 180)
    .sort((a, b) => (b.score - a.score) || (a.top - b.top) || (a.left - b.left));

  if (!scored.length) {
    return null;
  }

  const best = scored[0];
  return {
    button: page.locator(PROFILE_ACTION_QUERY).nth(best.queryIndex),
    label: best.label,
    scoredCandidates: scored.slice(0, 8).map((item) => ({
      label: item.label,
      text: item.text,
      aria: item.aria,
      score: item.score,
      top: item.top,
      left: item.left
    }))
  };
}

async function findProfileMoreButton(page, providedSnapshot = null) {
  const snapshot = providedSnapshot || await collectProfileActionSnapshot(page);
  const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];
  const candidates = actions
    .filter((item) => /^more$/i.test(item.label) || /^more$/i.test(item.text) || /^more$/i.test(item.aria))
    .sort((a, b) => (a.top - b.top) || (a.left - b.left));
  if (!candidates.length) return null;
  return page.locator(PROFILE_ACTION_QUERY).nth(candidates[0].queryIndex);
}

async function clickConnectOptionFromOpenMenuDom(page, receiverName = '') {
  const receiver = String(receiverName || '').toLowerCase().trim();
  return page.evaluate((receiverNameLower) => {
    const receiverTokens = receiverNameLower
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    };

    const menuRoots = [
      ...document.querySelectorAll(
        '[role="menu"], .artdeco-dropdown__content, .artdeco-popover__content'
      )
    ].filter(isVisible);

    const scored = [];
    for (const root of menuRoots) {
      const actionNodes = [
        ...root.querySelectorAll('button, [role="menuitem"], [role="button"], a, li, div')
      ].filter(isVisible);

      for (const node of actionNodes) {
        const label = normalize(node.getAttribute('aria-label') || node.textContent);
        if (!label) continue;
        const lower = label.toLowerCase();

        let score = 0;
        if (/^\s*connect\s*$/i.test(label)) score = 260;
        else if (/invite .* to connect/i.test(lower)) score = 220;
        else if (/connect/i.test(lower)) score = 160;
        else continue;

        if (/(follow|message|report|block|mute|share|privacy|terms)/i.test(lower)) {
          score -= 200;
        }
        if (receiverTokens.length && receiverTokens.some((token) => lower.includes(token))) {
          score += 120;
        }

        scored.push({ node, label, score });
      }
    }

    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 100) {
      return {
        clicked: false,
        seen: scored.slice(0, 12).map((x) => `${x.label} [${Math.round(x.score)}]`)
      };
    }

    best.node.click();
    return { clicked: true, label: best.label };
  }, receiver);
}

async function clickConnectOptionNearAnchor(page, anchorBox, receiverName = '') {
  const anchor = anchorBox
    ? { cx: anchorBox.x + anchorBox.width / 2, cy: anchorBox.y + anchorBox.height / 2 }
    : { cx: 520, cy: 320 };
  const receiver = String(receiverName || '').toLowerCase().trim();

  return page.evaluate(({ anchorPoint, receiverNameLower }) => {
    const receiverTokens = receiverNameLower
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    };

    const badLabel = /(follow|message|report|block|mute|share|save|copy|unsubscribe|privacy)/i;
    const nodes = [
      ...document.querySelectorAll('button, [role="menuitem"], [role="button"], li, div[aria-label]')
    ].filter(isVisible);

    const scored = nodes
      .map((node) => {
        const label = normalize(node.getAttribute('aria-label') || node.textContent);
        if (!label) return null;
        const lower = label.toLowerCase();
        if (badLabel.test(lower)) return null;

        const rect = node.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(cx - anchorPoint.cx, cy - anchorPoint.cy);

        let score = -dist / 10;
        if (/^\+?\s*connect\s*$/i.test(label)) score += 360;
        else if (/^\s*connect\s+/i.test(label)) score += 320;
        else if (/invite .* to connect/i.test(lower)) score += 260;
        else if (/connect/i.test(lower)) score += 140;
        else return null;

        if (receiverTokens.length && receiverTokens.some((token) => lower.includes(token))) {
          score += 140;
        }
        if (rect.left > 850) score -= 250;

        return { node, label, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 60) {
      return {
        clicked: false,
        label: '',
        seen: scored.slice(0, 12).map((x) => `${x.label} [${Math.round(x.score)}]`)
      };
    }

    best.node.click();
    return {
      clicked: true,
      label: best.label,
      seen: scored.slice(0, 12).map((x) => `${x.label} [${Math.round(x.score)}]`)
    };
  }, { anchorPoint: anchor, receiverNameLower: receiver });
}

async function clickSafeConnectFromMoreMenu(page, anchorBox, receiverName = '', profileNameTokens = []) {
  const anchor = anchorBox
    ? { cx: anchorBox.x + anchorBox.width / 2, cy: anchorBox.y + anchorBox.height / 2 }
    : { cx: 520, cy: 320 };
  const receiver = String(receiverName || '').toLowerCase().trim();

  return page.evaluate(({ anchorPoint, receiverNameLower, profileTokens }) => {
    const receiverTokens = receiverNameLower
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const safeTokens = Array.isArray(profileTokens) && profileTokens.length
      ? profileTokens
      : receiverTokens;

    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    };

    const roots = [
      ...document.querySelectorAll('[role="menu"], .artdeco-dropdown__content, .artdeco-popover__content')
    ].filter(isVisible);

    if (!roots.length) {
      return { clicked: false, seen: [], reason: 'No visible menu root after clicking More.' };
    }

    const nearestRoot = roots
      .map((root) => {
        const rect = root.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(cx - anchorPoint.cx, cy - anchorPoint.cy);
        return { root, dist };
      })
      .sort((a, b) => a.dist - b.dist)[0].root;

    const actionNodes = [
      ...nearestRoot.querySelectorAll('button, [role="menuitem"], [role="button"], a, li, div')
    ].filter(isVisible);

    const actions = actionNodes
      .map((node) => {
        const label = normalize(node.getAttribute('aria-label') || node.textContent);
        return { node, label, lower: label.toLowerCase() };
      })
      .filter((item) => item.label);

    const exactConnect = actions.find((a) => /^\s*connect\s*$/i.test(a.label));
    if (exactConnect) {
      exactConnect.node.click();
      return { clicked: true, label: exactConnect.label, seen: actions.slice(0, 20).map((a) => a.label) };
    }

    const inviteTarget = actions.find((a) => {
      if (!/invite .* to connect/i.test(a.lower)) return false;
      if (!safeTokens.length) return false;
      return safeTokens.some((token) => a.lower.includes(token));
    });
    if (inviteTarget) {
      inviteTarget.node.click();
      return { clicked: true, label: inviteTarget.label, seen: actions.slice(0, 20).map((a) => a.label) };
    }

    return {
      clicked: false,
      seen: actions.slice(0, 20).map((a) => a.label),
      reason: 'No safe Connect action found in opened More menu.'
    };
  }, {
    anchorPoint: anchor,
    receiverNameLower: receiver,
    profileTokens: profileNameTokens
  });
}

async function pickConnectOptionFromMoreMenu(page, receiverName = '', profileNameTokens = []) {
  const receiverTokens = String(receiverName || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const safeTokens = Array.isArray(profileNameTokens) && profileNameTokens.length
    ? profileNameTokens
    : receiverTokens;

  const menuOptions = page.locator('[role="menu"] [role="menuitem"], [role="menu"] button');
  const total = await menuOptions.count();

  for (let i = 0; i < total; i += 1) {
    const item = menuOptions.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;
    const label = (
      ((await item.getAttribute('aria-label')) || '') ||
      ((await item.textContent()) || '')
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!label) continue;
    const lower = label.toLowerCase();

    if (/^\s*connect\s*$/i.test(label)) {
      return item;
    }

    if (/invite .* to connect/i.test(lower)) {
      if (safeTokens.length && safeTokens.some((token) => lower.includes(token))) {
        return item;
      }
    }
  }

  return null;
}

async function retryConnectActionIfNeeded(page, receiverName = '', profileNameTokens = []) {
  const snapshot = await collectProfileActionSnapshot(page).catch(() => null);
  const moreBtn = (
    await findProfileMoreButton(page, snapshot)
  ) || (
    await findVisibleByNames(page, ['More'], snapshot)
  );
  if (moreBtn) {
    const anchorBox = await moreBtn.boundingBox().catch(() => null);
    await robustClick(page, moreBtn, { dismissOverlays: true });
    await page.waitForTimeout(500);
    const connectOption = await pickConnectOptionFromMoreMenu(
      page,
      receiverName,
      profileNameTokens
    );
    if (connectOption) {
      await robustClick(page, connectOption);
      return true;
    }

    const safeMenuChoice = await clickSafeConnectFromMoreMenu(
      page,
      anchorBox,
      receiverName,
      profileNameTokens
    );
    if (safeMenuChoice.clicked) {
      return true;
    }
  }

  const directConnect = await findProfilePrimaryConnectButton(
    page,
    receiverName,
    profileNameTokens,
    await collectProfileActionSnapshot(page).catch(() => null)
  );
  if (directConnect) {
    await robustClick(page, directConnect.button, { dismissOverlays: true });
    return true;
  }

  return false;
}

function scoreInviteActionLabel(label) {
  const text = String(label || '').trim().toLowerCase();
  if (!text) return -100;

  if (/(cancel|close|dismiss|back|not now|skip)/i.test(text)) {
    return -100;
  }

  if (/send without a note/i.test(text)) return 120;
  if (/send invitation|send invite/i.test(text)) return 110;
  if (/^send$/i.test(text)) return 100;
  if (/invite|invitation/i.test(text)) return 90;
  if (/done|next|continue|submit/i.test(text)) return 60;

  return 0;
}

function pickBestInviteAction(actions) {
  let best = null;
  for (const action of actions) {
    const score = scoreInviteActionLabel(action.label);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { ...action, score };
    }
  }
  return best;
}

function isLinkedinAuthenticated(url) {
  if (!url || url === 'about:blank') return false;
  // Checkpoint / verification pages — user is NOT yet authenticated
  if (/linkedin\.com\/checkpoint\//i.test(url)) return false;
  if (/linkedin\.com\/uas\//i.test(url)) return false;
  if (/linkedin\.com\/login/i.test(url)) return false;
  if (/linkedin\.com\/authwall/i.test(url)) return false;
  // Pages that only appear after a successful login
  if (/linkedin\.com\/feed/i.test(url)) return true;
  if (/linkedin\.com\/in\/[^/?#]+/i.test(url)) return true;
  if (/linkedin\.com\/(mynetwork|jobs|messaging|notifications|search|learning|company|school)\//i.test(url)) return true;
  if (/^https?:\/\/(www\.)?linkedin\.com\/?$/.test(url)) return true;
  return false;
}

async function waitForLinkedinLogin(page, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();

    if (isLinkedinAuthenticated(currentUrl)) {
      return;
    }

    // Log what we are waiting on so debug screenshots capture it.
    // If still on the login form, do nothing extra.
    // If on a checkpoint/verification page (mobile app approve, email OTP, CAPTCHA),
    // we simply keep polling — LinkedIn will redirect to the feed once the user approves.
    await page.waitForTimeout(1000);
  }

  throw new Error(
    'LinkedIn login did not complete in time. ' +
    'If LinkedIn asked you to verify via the mobile app or email, ' +
    'please approve it in the browser that opened and try again.'
  );
}

function extractLinkedinUrl(row) {
  for (const key of LINKEDIN_URL_CANDIDATES) {
    const value = row[key];
    if (typeof value === 'string' && value.includes('linkedin.com/in/')) {
      return value.trim();
    }
  }

  for (const value of Object.values(row)) {
    if (typeof value === 'string' && value.includes('linkedin.com/in/')) {
      return value.trim();
    }
  }

  return '';
}

function buildLinkedinLeads(rawRows) {
  return rawRows
    .map(normalizeRow)
    .map((row) => {
      const linkedinUrl = extractLinkedinUrl(row);
      const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      return {
        ...row,
        linkedin_url: linkedinUrl,
        receiver_name: fullName || row.name || '',
        company_name: row.company_name || row.company || ''
      };
    })
    .filter((row) => row.linkedin_url);
}

function createLinkedinJobManager() {
  const jobs = new Map();

  function getJob(jobId) {
    return jobs.get(jobId) || null;
  }

  function createJob({ total, logFile, debugLogFile = null, artifactsDir = null }) {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total,
      processed: 0,
      sentConnectRequests: 0,
      skipped: 0,
      failed: 0,
      logFile,
      debugLogFile,
      artifactsDir,
      results: [],
      error: null
    };
    jobs.set(id, job);
    return job;
  }

  function appendResult(jobId, result) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.results.push(result);
    job.processed += 1;
    if (result.status === 'connect_sent' || result.status === 'dm_sent') {
      job.sentConnectRequests += 1;
    } else if (result.status === 'skipped') {
      job.skipped += 1;
    } else if (result.status === 'failed') {
      job.failed += 1;
    }
  }

  function finishJob(jobId, error = null) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = error ? 'failed' : 'completed';
    job.error = error ? String(error.message || error) : null;
    job.finishedAt = new Date().toISOString();
  }

  return {
    createJob,
    getJob,
    appendResult,
    finishJob
  };
}

async function findVisibleByNames(page, names, providedSnapshot = null) {
  const snapshot = providedSnapshot || await collectProfileActionSnapshot(page).catch(() => null);
  const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];

  for (const action of actions) {
    if (matchesNamedAction(action, names)) {
      return page.locator(PROFILE_ACTION_QUERY).nth(action.queryIndex);
    }
  }

  // Fallback for pages where profile-card actions are not detectable.
  for (const name of names) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}\\b`, 'i') }).first();
    if (await button.count()) return button;

    const link = page.getByRole('link', { name: new RegExp(`^${name}\\b`, 'i') }).first();
    if (await link.count()) return link;
  }
  return null;
}

async function extractCurrentProfileNameTokens(page, providedSnapshot = null) {
  const snapshot = providedSnapshot || await collectProfileActionSnapshot(page).catch(() => null);
  const headingTokens = tokenizeName(snapshot?.headingText || '');
  if (headingTokens.length) {
    return headingTokens;
  }

  const candidateTokens = (snapshot?.headingCandidates || [])
    .flatMap((candidate) => tokenizeName(candidate.text));
  if (candidateTokens.length) {
    return [...new Set(candidateTokens)];
  }

  const urlSlug = extractLinkedinSlug(snapshot?.pageUrl || page.url());
  return tokenizeName(urlSlug.replace(/-/g, ' '));
}

async function detectConnectionDegree(page) {
  return page.evaluate(() => {
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 6 && rect.height > 6;
    };

    const main = document.querySelector('main');
    if (!main) return { degree: '', isFirstDegree: false, evidence: [] };

    const nodes = [...main.querySelectorAll('span, div, a, p')]
      .filter(isVisible)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 180 && rect.top <= 520 && rect.left >= 40 && rect.left <= 760;
      });

    const texts = nodes
      .map((el) => normalize(el.textContent))
      .filter(Boolean)
      .slice(0, 120);
    const joined = texts.join(' | ');

    if (/\b1st\b/.test(joined)) return { degree: '1st', isFirstDegree: true, evidence: texts.slice(0, 20) };
    if (/\b2nd\b/.test(joined)) return { degree: '2nd', isFirstDegree: false, evidence: texts.slice(0, 20) };
    if (/\b3rd\b/.test(joined)) return { degree: '3rd', isFirstDegree: false, evidence: texts.slice(0, 20) };
    return { degree: '', isFirstDegree: false, evidence: texts.slice(0, 20) };
  }).catch(() => ({ degree: '', isFirstDegree: false, evidence: [] }));
}

function inferTopCardRelationship(snapshot, receiverName = '') {
  const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];
  const receiverTokens = tokenizeName(receiverName);
  const normalizeLower = (value) => normalizeInlineText(value).toLowerCase();

  const hasFollowCta = actions.some((item) => {
    const label = normalizeLower(item.label);
    const aria = normalizeLower(item.aria);
    const text = normalizeLower(item.text);
    if (!label && !aria && !text) return false;

    const startsWithFollow = (
      /^follow\b/.test(label) ||
      /^follow\b/.test(aria) ||
      /^follow\b/.test(text)
    );
    if (!startsWithFollow) return false;
    if (!receiverTokens.length) return true;
    const combined = `${label} ${aria} ${text}`;
    return receiverTokens.some((token) => combined.includes(token));
  });

  const hasFollowingCta = actions.some((item) => {
    const label = normalizeLower(item.label);
    const aria = normalizeLower(item.aria);
    const text = normalizeLower(item.text);
    return (
      /^following\b/.test(label) ||
      /^following\b/.test(aria) ||
      /^following\b/.test(text)
    );
  });

  return {
    hasFollowCta,
    hasFollowingCta,
    likelyFirstDegree: hasFollowingCta || !hasFollowCta
  };
}

async function appendLog(logFile, data) {
  await fs.appendFile(logFile, `${JSON.stringify(data)}\n`, 'utf8');
}

async function processProfile({
  page,
  lead,
  connectTemplate,
  dmTemplate,
  jobDebugLog,
  artifactsDir,
  leadIndex
}) {
  const result = {
    timestamp: new Date().toISOString(),
    linkedinUrl: lead.linkedin_url,
    companyName: lead.company_name || '',
    receiverName: lead.receiver_name || '',
    status: 'skipped',
    detail: '',
    debugSteps: [],
    screenshot: null
  };

  async function addDebug(step, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      leadIndex,
      linkedinUrl: lead.linkedin_url,
      receiverName: lead.receiver_name || '',
      step,
      data
    };
    result.debugSteps.push(entry);
    if (jobDebugLog) {
      await jobDebugLog(entry);
    }
  }

  await addDebug('profile_open_start');
  await openProfileWithAuthHandling(page, lead.linkedin_url);
  await page.waitForTimeout(1500);
  const initialScreenshot = await captureDebugScreenshot(page, artifactsDir, lead, 'loaded');
  if (initialScreenshot) {
    result.screenshot = initialScreenshot;
  }
  await addDebug('profile_open_done', { screenshot: initialScreenshot });

  const signInField = page.locator('input[name="session_key"]');
  if (await signInField.count()) {
    await addDebug('login_required_detected');
    await waitForLinkedinLogin(page);
    await openProfileWithAuthHandling(page, lead.linkedin_url);
    await page.waitForTimeout(1200);
    await addDebug('login_completed_and_profile_reopened');
  }

  const closedPreflightDialog = await closeBlockingDialogs(page);
  if (closedPreflightDialog) {
    await addDebug('preflight_dialog_closed');
    await page.waitForTimeout(300);
  }

  let profileSnapshot = await collectProfileActionSnapshot(page).catch(() => null);
  const expectedSlug = extractLinkedinSlug(lead.linkedin_url);
  const actualSlug = extractLinkedinSlug(profileSnapshot?.pageUrl || page.url());
  await addDebug('profile_surface_snapshot', {
    pageUrl: profileSnapshot?.pageUrl || page.url(),
    pageTitle: profileSnapshot?.pageTitle || '',
    headingText: profileSnapshot?.headingText || '',
    headingCandidates: profileSnapshot?.headingCandidates || [],
    zone: profileSnapshot?.zone || null,
    topProfileActions: (profileSnapshot?.actions || []).slice(0, 20).map((item) => ({
      label: item.label,
      text: item.text,
      aria: item.aria,
      top: item.top,
      left: item.left
    }))
  });
  if (!isLikelySameProfileSlug(expectedSlug, actualSlug)) {
    result.status = 'failed';
    result.detail = `Safety stop: opened profile slug "${actualSlug || '-'}" did not match target slug "${expectedSlug || '-'}".`;
    const mismatchShot = await captureDebugScreenshot(page, artifactsDir, lead, 'failed-profile-mismatch');
    if (mismatchShot) result.screenshot = mismatchShot;
    await addDebug('profile_slug_mismatch', {
      expectedSlug,
      actualSlug,
      screenshot: mismatchShot
    });
    return result;
  }

  const profileNameTokens = await extractCurrentProfileNameTokens(page, profileSnapshot);
  await addDebug('profile_name_tokens', { profileNameTokens });

  const messageBtn = await findVisibleByNames(page, ['Message'], profileSnapshot);
  const directConnect = await findProfilePrimaryConnectButton(
    page,
    lead.receiver_name,
    profileNameTokens,
    profileSnapshot
  );
  const directConnectBtn = directConnect ? directConnect.button : null;
  const pendingBtn = await findVisibleByNames(page, ['Pending'], profileSnapshot);
  const connectionDegree = await detectConnectionDegree(page);
  const relationshipHints = inferTopCardRelationship(profileSnapshot, lead.receiver_name);
  await addDebug('primary_actions_detected', {
    hasMessage: Boolean(messageBtn),
    hasDirectConnect: Boolean(directConnectBtn),
    hasPending: Boolean(pendingBtn),
    connectionDegree,
    relationshipHints,
    directConnectLabel: directConnect ? directConnect.label : '',
    profileActionLabels: (profileSnapshot?.actions || []).slice(0, 20).map((item) => item.label),
    scoredConnectCandidates: directConnect?.scoredCandidates || []
  });

  if (pendingBtn) {
    result.status = 'skipped';
    result.detail = 'Connection request already pending.';
    await addDebug('skip_pending_already_present');
    return result;
  }

  const likelyExistingConnection = (
    !directConnectBtn &&
    Boolean(messageBtn) &&
    (
      connectionDegree.isFirstDegree ||
      relationshipHints.likelyFirstDegree
    )
  );

  if (likelyExistingConnection) {
    const dmResult = await sendDirectMessageToConnection({
      page,
      messageButton: messageBtn,
      dmTemplate,
      lead,
      addDebug
    });
    if (!dmResult.ok) {
      result.status = 'skipped';
      result.detail = `Already connected, but DM was not sent. ${dmResult.evidence}`;
      await addDebug('dm_skipped_existing_connection', { evidence: dmResult.evidence });
      return result;
    }
    result.status = 'dm_sent';
    result.detail = `Direct message sent (${dmResult.evidence}).`;
    await addDebug('dm_sent_existing_connection', { evidence: dmResult.evidence });
    return result;
  }

  if (messageBtn && !directConnectBtn && !likelyExistingConnection) {
    result.status = 'skipped';
    result.detail = `Message action is visible but profile is not confirmed as an existing 1st-degree connection (degree=${connectionDegree.degree || 'unknown'}, followCta=${relationshipHints.hasFollowCta ? 'yes' : 'no'}). DM skipped.`;
    await addDebug('skip_message_visible_not_existing_connection', {
      connectionDegree,
      relationshipHints
    });
    return result;
  }

  let connectBtn = directConnectBtn;
  let connectClickedAlready = false;

  if (!connectBtn) {
    profileSnapshot = await collectProfileActionSnapshot(page).catch(() => profileSnapshot);
    const moreBtn = (
      await findProfileMoreButton(page, profileSnapshot)
    ) || (
      await findVisibleByNames(page, ['More'], profileSnapshot)
    );
    if (moreBtn) {
      await addDebug('more_button_found', {
        profileActionLabels: (profileSnapshot?.actions || []).slice(0, 20).map((item) => item.label)
      });
      const anchorBox = await moreBtn.boundingBox().catch(() => null);
      await robustClick(page, moreBtn, { dismissOverlays: true });
      await page.waitForTimeout(600);
      const menuLabels = await collectMenuLabels(page).catch(() => []);
      await addDebug('more_menu_opened', { menuLabels });
      connectBtn = await pickConnectOptionFromMoreMenu(
        page,
        lead.receiver_name,
        profileNameTokens
      );
      await addDebug('pick_connect_option_from_menu', { found: Boolean(connectBtn) });
      if (!connectBtn) {
        const safeMenuChoice = await clickSafeConnectFromMoreMenu(
          page,
          anchorBox,
          lead.receiver_name,
          profileNameTokens
        );
        await addDebug('safe_menu_dom_choice', safeMenuChoice);
        if (safeMenuChoice.clicked) {
          connectClickedAlready = true;
        }
      }
    }
  }

  if (!connectBtn && !connectClickedAlready) {
    profileSnapshot = await collectProfileActionSnapshot(page).catch(() => profileSnapshot);
    const labels = (profileSnapshot?.actions || []).slice(0, 20).map((item) => item.label);
    const fallbackLabels = labels.length ? labels : await collectMainActionLabels(page);
    result.status = 'skipped';
    result.detail = `No safe profile Connect action available on profile. Main actions seen: ${fallbackLabels.join(' | ')}`;
    const skipShot = await captureDebugScreenshot(page, artifactsDir, lead, 'skip-no-connect');
    if (skipShot) result.screenshot = skipShot;
    await addDebug('skip_no_connect_action', {
      labels: fallbackLabels,
      screenshot: skipShot,
      pageUrl: profileSnapshot?.pageUrl || page.url(),
      headingText: profileSnapshot?.headingText || ''
    });
    return result;
  }

  if (!connectClickedAlready) {
    await robustClick(page, connectBtn, { dismissOverlays: true });
    await addDebug('connect_clicked_via_locator');
  } else {
    await addDebug('connect_clicked_via_safe_menu_dom');
  }
  await page.waitForTimeout(700);

  const closedPostConnectDialog = await closeBlockingDialogs(page);
  if (closedPostConnectDialog) {
    await addDebug('post_connect_blocking_dialog_closed');
    await page.waitForTimeout(300);
  }

  const surface = await waitForConnectSurface(page);
  await addDebug('connect_surface_detected', { surface: surface.type });
  if (surface.type === 'pending') {
    result.status = 'connect_sent';
    result.detail = 'Connection request sent (Pending button visible).';
    await addDebug('connect_sent_pending_visible');
    return result;
  }
  if (surface.type === 'toast') {
    result.status = 'connect_sent';
    result.detail = 'Connection request sent (LinkedIn toast confirmation visible).';
    await addDebug('connect_sent_toast_visible');
    return result;
  }
  if (surface.type === 'send_without_note_inline') {
    const sendWithoutNote = page.getByRole('button', { name: /Send without a note/i }).first();
    await robustClick(page, sendWithoutNote);
    const confirmation = await confirmInvitationSent(page);
    if (!confirmation.ok) {
      throw new Error(`Send without note clicked but send was not confirmed. ${confirmation.evidence}.`);
    }
    result.status = 'connect_sent';
    result.detail = `Connection request sent (${confirmation.evidence}).`;
    await addDebug('connect_sent_without_note', { evidence: confirmation.evidence });
    return result;
  }
  if (surface.type !== 'dialog') {
    await addDebug('surface_missing_initial', { surface: surface.type });
    const retried = await retryConnectActionIfNeeded(
      page,
      lead.receiver_name,
      profileNameTokens
    );
    await addDebug('retry_connect_attempted', { retried });
    if (retried) {
      const retrySurface = await waitForConnectSurface(page, 9000);
      await addDebug('retry_surface_detected', { surface: retrySurface.type });
      if (retrySurface.type === 'pending') {
        result.status = 'connect_sent';
        result.detail = 'Connection request sent after retry (Pending button visible).';
        await addDebug('connect_sent_after_retry_pending');
        return result;
      }
      if (retrySurface.type === 'toast') {
        result.status = 'connect_sent';
        result.detail = 'Connection request sent after retry (LinkedIn toast confirmation visible).';
        await addDebug('connect_sent_after_retry_toast');
        return result;
      }
      if (retrySurface.type === 'send_without_note_inline') {
        const sendWithoutNote = page.getByRole('button', { name: /Send without a note/i }).first();
        await robustClick(page, sendWithoutNote);
        const confirmation = await confirmInvitationSent(page);
        if (!confirmation.ok) {
          throw new Error(
            `Send without note clicked after retry but send was not confirmed. ${confirmation.evidence}.`
          );
        }
        result.status = 'connect_sent';
        result.detail = `Connection request sent after retry (${confirmation.evidence}).`;
        await addDebug('connect_sent_after_retry_without_note', { evidence: confirmation.evidence });
        return result;
      }
      if (retrySurface.type === 'dialog') {
        surface.type = 'dialog';
        surface.dialog = retrySurface.dialog;
      } else if (retrySurface.type === 'add_note_inline') {
        surface.type = 'add_note_inline';
      } else {
        const labels = await collectMainActionLabels(page);
        result.status = 'skipped';
        result.detail = `Connect not available for this profile after retry. Main actions seen: ${labels.join(' | ')}`;
        const retrySkipShot = await captureDebugScreenshot(page, artifactsDir, lead, 'skip-after-retry');
        if (retrySkipShot) result.screenshot = retrySkipShot;
        await addDebug('skip_after_retry_no_surface', { labels, screenshot: retrySkipShot });
        return result;
      }
    } else {
      const labels = await collectMainActionLabels(page);
      result.status = 'skipped';
      result.detail = `Connect not available for this profile. Main actions seen: ${labels.join(' | ')}`;
      const noRetrySkipShot = await captureDebugScreenshot(page, artifactsDir, lead, 'skip-no-retry');
      if (noRetrySkipShot) result.screenshot = noRetrySkipShot;
      await addDebug('skip_no_retry_surface', { labels, screenshot: noRetrySkipShot });
      return result;
    }
  }

  const inviteRoot = surface.type === 'dialog' ? surface.dialog : page;
  if (surface.type === 'dialog') {
    const sendWithoutNoteInDialog = inviteRoot
      .getByRole('button', { name: /Send without a note/i })
      .first();
    if (await sendWithoutNoteInDialog.count()) {
      await robustClick(page, sendWithoutNoteInDialog);
      const confirmation = await confirmInvitationSent(page);
      if (confirmation.ok) {
        result.status = 'connect_sent';
        result.detail = `Connection request sent without note (${confirmation.evidence}).`;
        await addDebug('connect_sent_dialog_without_note', { evidence: confirmation.evidence });
        return result;
      }
      await addDebug('connect_dialog_without_note_not_confirmed', { evidence: confirmation.evidence });
    }
  }

  if (surface.type !== 'add_note_inline') {
    const addNoteBtn = inviteRoot.getByRole('button', { name: /Add a note|Add note/i }).first();
    if (await addNoteBtn.count()) {
      await robustClick(page, addNoteBtn);
      await page.waitForTimeout(400);
      await addDebug('add_note_clicked');
    }
  }

  const noteInput = inviteRoot
    .locator('textarea[name="message"], textarea, [contenteditable="true"][role="textbox"]')
    .first();
  const message = renderTemplate(connectTemplate, lead).trim();
  if (message && (await noteInput.count())) {
    const clipped = message.slice(0, 300);
    const tag = await fillMessageInput(noteInput, clipped);
    await addDebug('note_filled', { length: clipped.length, tag: tag || 'unknown' });
  }

  let sendBtn = null;
  const strictVariants = [
    /^Send$/i,
    /Send invitation/i,
    /Send invite/i,
    /Send without a note/i,
    /^Done$/i,
    /^Next$/i,
    /^Continue$/i
  ];
  for (const pattern of strictVariants) {
    const candidate = inviteRoot.getByRole('button', { name: pattern }).first();
    if (await candidate.count()) {
      sendBtn = candidate;
      break;
    }
  }

  if (!sendBtn) {
    const buttons = inviteRoot.locator('button');
    const total = await buttons.count();
    const candidates = [];
    for (let i = 0; i < total; i += 1) {
      const button = buttons.nth(i);
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;
      const label = (
        ((await button.getAttribute('aria-label')) || '') ||
        ((await button.textContent()) || '')
      ).trim();
      candidates.push({ label, index: i });
    }

    const best = pickBestInviteAction(candidates);
    if (best) {
      sendBtn = buttons.nth(best.index);
      await addDebug('send_button_picked_from_candidates', { label: best.label });
    } else {
      if (surface.type !== 'dialog') {
        const labels = candidates.map((c) => c.label).filter(Boolean).slice(0, 20);
        await addDebug('send_button_missing_in_inline_controls', { labels });
        throw new Error(
          `Unable to find a send/invite button in invite controls. Buttons seen: ${labels.join(' | ')}`
        );
      }

      const domFallback = await domFindAndClickInviteAction(inviteRoot);
      if (!domFallback.clicked) {
        const labels = candidates.map((c) => c.label).filter(Boolean).slice(0, 10);
        const merged = [...labels, ...(domFallback.labels || [])]
          .filter(Boolean)
          .slice(0, 20);
        await addDebug('send_button_missing_in_dialog', { merged });
        const noNoteFallback = await attemptNoNoteFallbackFromDialog({ page, addDebug });
        if (noNoteFallback.ok) {
          result.status = 'connect_sent';
          result.detail = `Connection request sent without note (${noNoteFallback.evidence}).`;
          await addDebug('connect_sent_without_note_after_missing_dialog_send', {
            evidence: noNoteFallback.evidence
          });
          return result;
        }
        result.status = 'skipped';
        result.detail = `Connect dialog did not allow sending right now. ${noNoteFallback.evidence}. Buttons seen: ${merged.join(' | ')}`;
        await addDebug('skip_connect_dialog_not_sendable', {
          evidence: noNoteFallback.evidence,
          labels: merged
        });
        return result;
      }
      await addDebug('send_clicked_via_dialog_dom_fallback', { label: domFallback.label || '' });
      const confirmation = await confirmInvitationSent(page);
      if (!confirmation.ok) {
        throw new Error(
          `Invite action clicked via DOM fallback (${domFallback.label || 'unknown'}) but not confirmed. ${confirmation.evidence}.`
        );
      }
      result.status = 'connect_sent';
      result.detail = `Connection request sent (${confirmation.evidence}).`;
      await addDebug('connect_sent_dialog_dom_fallback', { evidence: confirmation.evidence });
      return result;
    }
  }

  const sendDisabled = await sendBtn.evaluate((el) => {
    const node = el;
    return Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true');
  }).catch(() => false);
  if (sendDisabled) {
    await addDebug('send_button_disabled_fallback_to_no_note');
    const fallbackConfirmation = await sendConnectionRequestWithoutNote(page);
    if (!fallbackConfirmation.ok) {
      throw new Error(`Send button is disabled and no-note fallback failed. ${fallbackConfirmation.evidence}`);
    }
    result.status = 'connect_sent';
    result.detail = `Connection request sent without note (${fallbackConfirmation.evidence}).`;
    await addDebug('connect_sent_without_note_fallback', { evidence: fallbackConfirmation.evidence });
    return result;
  }

  await robustClick(page, sendBtn);
  await addDebug('send_button_clicked');
  const confirmation = await confirmInvitationSent(page);
  if (!confirmation.ok) {
    throw new Error(`Invite button clicked but send was not confirmed. ${confirmation.evidence}.`);
  }
  result.status = 'connect_sent';
  result.detail = `Connection request sent (${confirmation.evidence}).`;
  await addDebug('connect_sent_confirmed', { evidence: confirmation.evidence });
  return result;
}

async function runLinkedinConnectCampaign({
  leads,
  connectTemplate,
  dmTemplate,
  delayMs,
  maxActions,
  sessionDir,
  logFile,
  debugLogFile = null,
  artifactsDir = null,
  onResult
}) {
  const isContextClosedError = (error) => /Target page, context or browser has been closed/i.test(
    String(error?.message || error || '')
  );

  async function writeDebug(data) {
    if (!debugLogFile) return;
    await appendLog(debugLogFile, data);
  }

  const context = await chromium.launchPersistentContext(sessionDir, {
    channel: 'chrome',
    headless: false,
    viewport: null
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await waitForLinkedinLogin(page);

    const cappedLeads = leads.slice(0, maxActions);
    for (let index = 0; index < cappedLeads.length; index += 1) {
      const lead = cappedLeads[index];
      let result;
      try {
        await writeDebug({
          timestamp: new Date().toISOString(),
          leadIndex: index,
          linkedinUrl: lead.linkedin_url,
          receiverName: lead.receiver_name || '',
          step: 'lead_processing_start'
        });
        result = await processProfile({
          page,
          lead,
          connectTemplate,
          dmTemplate,
          jobDebugLog: writeDebug,
          artifactsDir,
          leadIndex: index
        });
      } catch (error) {
        if (isContextClosedError(error)) {
          result = {
            timestamp: new Date().toISOString(),
            linkedinUrl: lead.linkedin_url,
            companyName: lead.company_name || '',
            receiverName: lead.receiver_name || '',
            status: 'failed',
            detail: 'LinkedIn browser window was closed during run. Job stopped. Reopen login and run again.',
            screenshot: null,
            debugSteps: [
              {
                timestamp: new Date().toISOString(),
                leadIndex: index,
                linkedinUrl: lead.linkedin_url,
                receiverName: lead.receiver_name || '',
                step: 'lead_processing_exception',
                data: {
                  message: String(error.message || error)
                }
              }
            ]
          };
          await appendLog(logFile, result);
          onResult(result);
          await writeDebug({
            timestamp: new Date().toISOString(),
            leadIndex: index,
            linkedinUrl: lead.linkedin_url,
            receiverName: lead.receiver_name || '',
            step: 'browser_context_closed_stop_job',
            data: {
              message: String(error.message || error)
            }
          });
          throw new Error('LinkedIn browser/context closed. Stopped the campaign run.');
        }

        const failMainActions = await collectMainActionLabels(page).catch(() => []);
        const failMenuLabels = await collectMenuLabels(page).catch(() => []);
        const failShot = await captureDebugScreenshot(page, artifactsDir, lead, 'failed-exception');
        result = {
          timestamp: new Date().toISOString(),
          linkedinUrl: lead.linkedin_url,
          companyName: lead.company_name || '',
          receiverName: lead.receiver_name || '',
          status: 'failed',
          detail: `${String(error.message || error)} | Main actions: ${failMainActions.join(' | ')} | Menu labels: ${failMenuLabels.join(' | ')}`,
          screenshot: failShot,
          debugSteps: [
            {
              timestamp: new Date().toISOString(),
              leadIndex: index,
              linkedinUrl: lead.linkedin_url,
              receiverName: lead.receiver_name || '',
              step: 'lead_processing_exception',
              data: {
                message: String(error.message || error)
              }
            }
          ]
        };
        await writeDebug({
          timestamp: new Date().toISOString(),
          leadIndex: index,
          linkedinUrl: lead.linkedin_url,
          receiverName: lead.receiver_name || '',
          step: 'lead_processing_exception',
          data: {
            message: String(error.message || error),
            stack: String(error.stack || ''),
            screenshot: failShot,
            mainActions: failMainActions,
            menuLabels: failMenuLabels
          }
        });
      }

      await appendLog(logFile, result);
      onResult(result);
      await writeDebug({
        timestamp: new Date().toISOString(),
        leadIndex: index,
        linkedinUrl: lead.linkedin_url,
        receiverName: lead.receiver_name || '',
        step: 'lead_processing_done',
        data: {
          status: result.status,
          detail: result.detail,
          screenshot: result.screenshot || null
        }
      });

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  } finally {
    await context.close().catch(() => null);
  }
}

module.exports = {
  buildLinkedinLeads,
  createLinkedinJobManager,
  runLinkedinConnectCampaign,
  scoreInviteActionLabel,
  pickBestInviteAction,
  inferTopCardRelationship
};
