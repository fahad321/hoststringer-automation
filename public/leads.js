'use strict';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const form            = document.getElementById('leadSearchForm');
const findBtn         = document.getElementById('findLeadsBtn');
const stopBtn         = document.getElementById('stopLeadsBtn');
const exportBtn       = document.getElementById('exportLeadsBtn');
const statusMsg       = document.getElementById('statusMessage');
const resultsCard     = document.getElementById('resultsCard');
const resultsSubtitle = document.getElementById('resultsSubtitle');
const statsBar        = document.getElementById('statsBar');
const statTotal       = document.getElementById('statTotal');
const statEmail       = document.getElementById('statEmail');
const statLinkedIn    = document.getElementById('statLinkedIn');
const filterRow       = document.getElementById('filterRow');
const filterLocation  = document.getElementById('filterLocation');
const filterSize      = document.getElementById('filterSize');
const filterSource    = document.getElementById('filterSource');
const filterContact   = document.getElementById('filterContact');
const emptyState      = document.getElementById('emptyState');
const leadsTable      = document.getElementById('leadsTable');
const leadsTableBody  = document.getElementById('leadsTableBody');

// ─── State ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'hoststringer_leads_form_v1';
let activeJobId   = null;
let pollTimer     = null;
let allLeads      = [];   // full unfiltered result set

// ─── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(msg) { statusMsg.textContent = msg; }

async function callApi(url, opts = {}) {
  const res = await fetch(url, opts);
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

// ─── Form persistence ────────────────────────────────────────────────────────
function saveForm() {
  const data = {
    keywords:       form.keywords.value,
    resourceType:   form.resourceType.value,
    industry:       form.industry.value,
    location:       form.location.value,
    companySize:    form.companySize.value,
    maxPerSource:   form.maxPerSource.value,
    enrichContacts: form.enrichContacts.checked,
    sources:        [...form.querySelectorAll('input[name="sources"]:checked')].map((cb) => cb.value)
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function restoreForm() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.keywords)     form.keywords.value     = d.keywords;
    if (d.resourceType) form.resourceType.value = d.resourceType;
    if (d.industry)     form.industry.value     = d.industry;
    if (d.location)     form.location.value     = d.location;
    if (d.companySize)  form.companySize.value  = d.companySize;
    if (d.maxPerSource) form.maxPerSource.value = d.maxPerSource;
    if (d.enrichContacts !== undefined) form.enrichContacts.checked = d.enrichContacts;
    if (Array.isArray(d.sources)) {
      form.querySelectorAll('input[name="sources"]').forEach((cb) => {
        cb.checked = d.sources.includes(cb.value);
      });
    }
  } catch (_) { localStorage.removeItem(STORAGE_KEY); }
}

form.addEventListener('change', saveForm);
form.addEventListener('input', saveForm);

// ─── Rendering ───────────────────────────────────────────────────────────────
function sourceBadge(source) {
  const cls = source === 'LinkedIn Jobs' ? 'badge-linkedin'
    : source === 'Indeed' ? 'badge-indeed'
    : source === 'Seek' ? 'badge-seek'
    : 'badge-web';
  return `<span class="source-badge ${cls}">${esc(source)}</span>`;
}

function contactPills(lead) {
  const pills = [];
  if (lead.emails && lead.emails.length) {
    lead.emails.slice(0, 2).forEach((e) => {
      pills.push(`<a class="contact-pill pill-email" href="mailto:${esc(e)}" title="${esc(e)}">✉ ${esc(e)}</a>`);
    });
  }
  if (lead.linkedinCompanyUrl) {
    pills.push(`<a class="contact-pill pill-linkedin" href="${esc(lead.linkedinCompanyUrl)}" target="_blank" rel="noopener">in LinkedIn</a>`);
  }
  if (!pills.length) {
    pills.push(`<span class="contact-pill pill-none">No contact yet</span>`);
  }
  return `<div class="contact-pills">${pills.join('')}</div>`;
}

function actionButtons(lead) {
  const emailParam = encodeURIComponent(
    JSON.stringify({ email: (lead.emails || [])[0] || '', company: lead.companyName })
  );
  const addEmail    = `<button class="btn-xs btn-xs-email" onclick="sendToEmail('${esc(lead.id)}')">✉ Email</button>`;
  const addLinkedIn = lead.linkedinCompanyUrl
    ? `<button class="btn-xs btn-xs-linkedin" onclick="openLinkedIn('${esc(lead.linkedinCompanyUrl)}')">in LinkedIn</button>`
    : '';
  return `${addEmail} ${addLinkedIn}`;
}

function renderRow(lead) {
  const websiteHtml = lead.companyWebsite
    ? `<a class="company-website" href="${esc(lead.companyWebsite)}" target="_blank" rel="noopener">↗ ${esc(lead.companyWebsite.replace(/^https?:\/\//, ''))}</a>`
    : '';

  const roles = (lead.openRoles || []).slice(0, 2).map((r) => `<div class="role-tag">${esc(r)}</div>`).join('');
  const snippet = lead.snippet ? `<div class="snippet-text">${esc(lead.snippet.slice(0, 120))}${lead.snippet.length > 120 ? '…' : ''}</div>` : '';

  return `
    <tr data-id="${esc(lead.id)}"
        data-location="${esc((lead.location || '').toLowerCase())}"
        data-size="${esc(lead.companySize || 'unknown')}"
        data-source="${esc(lead.source || '')}"
        data-has-email="${lead.emails && lead.emails.length ? 'yes' : 'no'}"
        data-has-li="${lead.linkedinCompanyUrl ? 'yes' : 'no'}">
      <td class="company-cell">
        <div class="company-name">${esc(lead.companyName)}</div>
        ${websiteHtml}
      </td>
      <td>${esc(lead.location || '—')}</td>
      <td>${roles}${snippet}</td>
      <td>${contactPills(lead)}</td>
      <td>${sourceBadge(lead.source)}</td>
      <td class="action-cell">${actionButtons(lead)}</td>
    </tr>
  `;
}

function applyFilters() {
  const locFilter     = filterLocation.value.toLowerCase().trim();
  const sizeFilter    = filterSize.value;
  const sourceFilter  = filterSource.value;
  const contactFilter = filterContact.value;

  let visible = 0;
  leadsTableBody.querySelectorAll('tr[data-id]').forEach((row) => {
    const locMatch     = !locFilter    || row.dataset.location.includes(locFilter);
    const sizeMatch    = !sizeFilter   || row.dataset.size    === sizeFilter;
    const sourceMatch  = !sourceFilter || row.dataset.source  === sourceFilter;
    const emailMatch   = contactFilter === 'email'  ? row.dataset.hasEmail === 'yes' : true;
    const liMatch      = contactFilter === 'linkedin' ? row.dataset.hasLi  === 'yes' : true;
    const bothMatch    = contactFilter === 'both'   ? (row.dataset.hasEmail === 'yes' && row.dataset.hasLi === 'yes') : true;

    const show = locMatch && sizeMatch && sourceMatch && emailMatch && liMatch && bothMatch;
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });

  resultsSubtitle.textContent = `${visible} lead${visible !== 1 ? 's' : ''} shown`;
}

[filterLocation, filterSize, filterSource, filterContact].forEach((el) =>
  el.addEventListener('input', applyFilters)
);

// ─── Polling ─────────────────────────────────────────────────────────────────
async function pollJob(jobId) {
  try {
    const job = await callApi(`/api/leads/job/${jobId}`);

    // Update stats
    statTotal.textContent    = job.found || 0;
    statEmail.textContent    = job.withEmail || 0;
    statLinkedIn.textContent = job.withLinkedIn || 0;

    // Add any new leads to the table
    const existingIds = new Set(
      [...leadsTableBody.querySelectorAll('tr[data-id]')].map((r) => r.dataset.id)
    );
    const newLeads = (job.results || []).filter((l) => !existingIds.has(l.id));
    if (newLeads.length) {
      leadsTableBody.insertAdjacentHTML('beforeend', newLeads.map(renderRow).join(''));
      allLeads = job.results;
      emptyState.style.display = 'none';
      leadsTable.style.display = '';
      filterRow.style.display  = '';
      statsBar.style.display   = '';
      applyFilters();
    }

    if (job.status === 'running') {
      setStatus(`${job.phase || 'Searching…'} — ${job.found} companies found so far.`);
      pollTimer = setTimeout(() => pollJob(jobId).catch((e) => setStatus(`Polling error: ${e.message}`)), 2500);
    } else {
      activeJobId = null;
      pollTimer   = null;
      setSearchingState(false);

      if (job.status === 'failed') {
        setStatus(`Search failed: ${job.error}`);
        resultsSubtitle.textContent = 'Search failed';
      } else {
        const count = job.found || 0;
        setStatus(`Search complete. ${count} unique ${count === 1 ? 'company' : 'companies'} found.`);
        resultsSubtitle.textContent = `${count} companies found`;
        if (count > 0) exportBtn.style.display = '';
      }
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// ─── UI state helpers ─────────────────────────────────────────────────────────
function setSearchingState(searching) {
  findBtn.disabled        = searching;
  findBtn.textContent     = searching ? 'Searching…' : 'Find Leads';
  stopBtn.style.display   = searching ? '' : 'none';
  exportBtn.style.display = 'none';
}

// ─── Form submit ──────────────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (activeJobId) return;

  // Gather sources
  const sources = [...form.querySelectorAll('input[name="sources"]:checked')].map((cb) => cb.value);
  if (!sources.length) { setStatus('Select at least one source.'); return; }

  // Reset results
  allLeads = [];
  leadsTableBody.innerHTML = '';
  emptyState.style.display = '';
  leadsTable.style.display = 'none';
  filterRow.style.display  = 'none';
  statsBar.style.display   = 'none';
  exportBtn.style.display  = 'none';
  statTotal.textContent = statEmail.textContent = statLinkedIn.textContent = '0';

  resultsCard.style.display = '';
  setSearchingState(true);
  setStatus('Starting search…');
  resultsSubtitle.textContent = 'Searching…';

  try {
    const body = {
      keywords:       form.keywords.value.trim(),
      location:       form.location.value.trim(),
      companySize:    form.companySize.value,
      resourceType:   form.resourceType.value,
      industry:       form.industry.value,
      sources,
      maxPerSource:   form.maxPerSource.value,
      enrichContacts: String(form.enrichContacts.checked)
    };

    const result = await callApi('/api/leads/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });

    activeJobId = result.jobId;
    await pollJob(result.jobId);
  } catch (err) {
    setSearchingState(false);
    setStatus(`Failed to start: ${err.message}`);
  }
});

// ─── Stop ─────────────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  try {
    await callApi(`/api/leads/stop/${activeJobId}`, { method: 'POST' });
  } catch (_) { /* ignore */ }
  if (pollTimer) clearTimeout(pollTimer);
  activeJobId = null;
  pollTimer   = null;
  setSearchingState(false);
  setStatus('Search stopped.');
});

// ─── Export ───────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!activeJobId && !allLeads.length) return;
  // Grab the last jobId from the URL or from a stored variable
  const jobId = document.querySelector('[data-job-id]')?.dataset?.jobId
    || window._lastJobId;
  if (jobId) {
    window.location.href = `/api/leads/export/${jobId}`;
  }
});

// Store jobId for export (set after successful search start)
const origSubmit = form.onsubmit;
form.addEventListener('submit', () => { window._lastJobId = activeJobId; }, true);

// ─── Action handlers (global, called from row HTML) ───────────────────────────
window.sendToEmail = function sendToEmail(leadId) {
  const lead = allLeads.find((l) => l.id === leadId);
  if (!lead) return;
  const email = (lead.emails || [])[0] || '';
  // Store lead in sessionStorage so the email page can pick it up
  sessionStorage.setItem('prefill_email_lead', JSON.stringify({
    email,
    company: lead.companyName,
    name: lead.companyName,
    location: lead.location
  }));
  window.location.href = '/index.html';
};

window.openLinkedIn = function openLinkedIn(url) {
  window.open(url, '_blank', 'noopener');
};

// ─── Init ─────────────────────────────────────────────────────────────────────
restoreForm();
