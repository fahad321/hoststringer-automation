'use strict';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const form            = document.getElementById('projectSearchForm');
const findBtn         = document.getElementById('findProjectsBtn');
const stopBtn         = document.getElementById('stopProjectsBtn');
const exportBtn       = document.getElementById('exportProjectsBtn');
const statusMsg       = document.getElementById('statusMessage');
const resultsCard     = document.getElementById('resultsCard');
const resultsSubtitle = document.getElementById('resultsSubtitle');
const statsBar        = document.getElementById('statsBar');
const statTotal       = document.getElementById('statTotal');
const statWithBudget  = document.getElementById('statWithBudget');
const filterRow       = document.getElementById('filterRow');
const filterKeyword   = document.getElementById('filterKeyword');
const filterPlatform  = document.getElementById('filterPlatform');
const filterType      = document.getElementById('filterType');
const emptyState      = document.getElementById('emptyState');
const projectsTable   = document.getElementById('projectsTable');
const tableBody       = document.getElementById('projectsTableBody');

// ─── State ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'hoststringer_projects_form_v1';
let activeJobId   = null;
let pollTimer     = null;
let allProjects   = [];

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
    keywords:     form.keywords.value,
    resourceType: form.resourceType.value,
    location:     form.location.value,
    maxPerSource: form.maxPerSource.value,
    sources:      [...form.querySelectorAll('input[name="sources"]:checked')].map((cb) => cb.value)
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
    if (d.location)     form.location.value     = d.location;
    if (d.maxPerSource) form.maxPerSource.value = d.maxPerSource;
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
function platformBadge(platform) {
  const cls = platform === 'Upwork'           ? 'badge-upwork'
    : platform === 'Freelancer'               ? 'badge-freelancer'
    : platform === 'PeoplePerHour'            ? 'badge-pph'
    : platform === 'Guru'                     ? 'badge-guru'
    : /Reddit/i.test(platform)               ? 'badge-reddit'
    : platform === 'LinkedIn'                 ? 'badge-linkedin'
    : platform === 'Government Tender'        ? 'badge-government'
    : 'badge-web';
  return `<span class="platform-badge ${cls}">${esc(platform)}</span>`;
}

function budgetChip(budget) {
  if (!budget) return `<span class="budget-chip empty">—</span>`;
  return `<span class="budget-chip">${esc(budget)}</span>`;
}

function skillTags(skills) {
  if (!skills || !skills.length) return '<span style="color:var(--text-muted);font-size:12px">—</span>';
  return `<div class="skill-tags">${skills.slice(0, 6).map((s) => `<span class="skill-tag">${esc(s)}</span>`).join('')}</div>`;
}

function typeTag(type) {
  const label = type === 'hourly'   ? 'Hourly'
    : type === 'tender'             ? 'Tender'
    : type === 'rfp'                ? 'RFP'
    : type === 'contract'           ? 'Contract'
    : 'Fixed';
  return `<span class="type-tag">${label}</span>`;
}

function renderRow(proj) {
  const contactHtml = proj.contactName
    ? `<div class="proj-contact">👤 ${esc(proj.contactName)}</div>`
    : '';
  const locationHtml = proj.location
    ? `<div class="proj-contact">📍 ${esc(proj.location)}</div>`
    : '';
  const postedHtml = proj.postedAt
    ? `<div class="proj-contact">🕐 ${esc(proj.postedAt)}</div>`
    : '';

  return `
    <tr data-id="${esc(proj.id)}"
        data-platform="${esc(proj.platform)}"
        data-type="${esc(proj.projectType || '')}"
        data-title="${esc((proj.title || '').toLowerCase())}">
      <td class="proj-title-cell">
        <div class="proj-title">${esc(proj.title)}</div>
        ${contactHtml}${locationHtml}${postedHtml}
      </td>
      <td>${platformBadge(proj.platform)}</td>
      <td>${budgetChip(proj.budget)}</td>
      <td>${skillTags(proj.skills)}</td>
      <td class="proj-desc">${esc((proj.description || '').slice(0, 160))}${(proj.description || '').length > 160 ? '…' : ''}</td>
      <td class="action-cell">
        <a class="btn-view" href="${esc(proj.listingUrl)}" target="_blank" rel="noopener">↗ View</a>
      </td>
    </tr>
  `;
}

function applyFilters() {
  const kwFilter  = filterKeyword.value.toLowerCase().trim();
  const platFilter = filterPlatform.value;
  const typeFilter = filterType.value;

  let visible = 0;
  tableBody.querySelectorAll('tr[data-id]').forEach((row) => {
    const kwMatch   = !kwFilter   || row.dataset.title.includes(kwFilter);
    const platMatch = !platFilter || row.dataset.platform === platFilter;
    const typeMatch = !typeFilter || row.dataset.type === typeFilter;
    const show = kwMatch && platMatch && typeMatch;
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });

  resultsSubtitle.textContent = `${visible} project${visible !== 1 ? 's' : ''} shown`;
}

[filterKeyword, filterPlatform, filterType].forEach((el) => el.addEventListener('input', applyFilters));

// ─── Polling ─────────────────────────────────────────────────────────────────
async function pollJob(jobId) {
  try {
    const job = await callApi(`/api/projects/job/${jobId}`);

    statTotal.textContent      = job.found || 0;
    statWithBudget.textContent = (job.results || []).filter((p) => p.budget).length;

    const existingIds = new Set(
      [...tableBody.querySelectorAll('tr[data-id]')].map((r) => r.dataset.id)
    );
    const newProjects = (job.results || []).filter((p) => !existingIds.has(p.id));
    if (newProjects.length) {
      tableBody.insertAdjacentHTML('beforeend', newProjects.map(renderRow).join(''));
      allProjects = job.results;
      emptyState.style.display   = 'none';
      projectsTable.style.display = '';
      filterRow.style.display    = '';
      statsBar.style.display     = '';
      applyFilters();
    }

    if (job.status === 'running') {
      setStatus(`${job.phase || 'Searching…'} — ${job.found} projects found so far.`);
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
        setStatus(`Search complete. ${count} project${count !== 1 ? 's' : ''} found.`);
        resultsSubtitle.textContent = `${count} project${count !== 1 ? 's' : ''} found`;
        if (count > 0) exportBtn.style.display = '';
      }
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// ─── UI state ─────────────────────────────────────────────────────────────────
function setSearchingState(searching) {
  findBtn.disabled        = searching;
  findBtn.textContent     = searching ? 'Searching…' : 'Find Projects';
  stopBtn.style.display   = searching ? '' : 'none';
  exportBtn.style.display = 'none';
}

// ─── Form submit ──────────────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (activeJobId) return;

  const sources = [...form.querySelectorAll('input[name="sources"]:checked')].map((cb) => cb.value);
  if (!sources.length) { setStatus('Select at least one source.'); return; }

  // Reset
  allProjects = [];
  tableBody.innerHTML = '';
  emptyState.style.display    = '';
  projectsTable.style.display = 'none';
  filterRow.style.display     = 'none';
  statsBar.style.display      = 'none';
  exportBtn.style.display     = 'none';
  statTotal.textContent = statWithBudget.textContent = '0';

  resultsCard.style.display = '';
  setSearchingState(true);
  setStatus('Starting project search…');
  resultsSubtitle.textContent = 'Searching…';

  try {
    const body = {
      keywords:     form.keywords.value.trim(),
      location:     form.location.value.trim(),
      resourceType: form.resourceType.value,
      maxPerSource: form.maxPerSource.value,
      sources
    };

    const result = await callApi('/api/projects/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });

    activeJobId = result.jobId;
    window._lastProjJobId = result.jobId;
    await pollJob(result.jobId);
  } catch (err) {
    setSearchingState(false);
    setStatus(`Failed to start: ${err.message}`);
  }
});

// ─── Stop ─────────────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  try { await callApi(`/api/projects/stop/${activeJobId}`, { method: 'POST' }); } catch (_) {}
  if (pollTimer) clearTimeout(pollTimer);
  activeJobId = null;
  pollTimer   = null;
  setSearchingState(false);
  setStatus('Search stopped.');
});

// ─── Export ───────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const jobId = window._lastProjJobId;
  if (jobId) window.location.href = `/api/projects/export/${jobId}`;
});

// ─── Init ─────────────────────────────────────────────────────────────────────
restoreForm();
