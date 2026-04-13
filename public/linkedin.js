const form = document.getElementById('linkedinForm');
const resetBtn = document.getElementById('resetLinkedinBtn');
const dryRunBtn = document.getElementById('dryRunLinkedinBtn');
const leadsFileInput = document.getElementById('linkedinLeadsFile');
const fileState = document.getElementById('linkedinFileState');
const statusMessageEl = document.getElementById('linkedinStatusMessage');
const statusListEl = document.getElementById('linkedinStatusList');

const STORAGE_KEY = 'linkedin_automation_form_v1';
const FILE_META_KEY = 'linkedin_automation_file_meta_v1';
const DB_NAME = 'hoststringer_campaign_db';
const FILE_STORE = 'files';
const FILE_KEY = 'linkedin_leads_file';

let activeJobId = null;
let pollTimer = null;
let persistedFile = null;

function setStatusMessage(message) {
  statusMessageEl.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusList(results = []) {
  if (!results.length) {
    statusListEl.innerHTML = '<div class="status-item"><strong>No activity yet.</strong></div>';
    return;
  }

  statusListEl.innerHTML = results
    .map((item) => {
      const company = escapeHtml(item.companyName || '-');
      const receiver = escapeHtml(item.receiverName || '-');
      const profile = escapeHtml(item.linkedinUrl || '-');
      const detail = escapeHtml(item.detail || '');
      const screenshot = escapeHtml(item.screenshot || '');
      const previewConnectMessage = escapeHtml(item.previewConnectMessage || '');
      const previewDmMessage = escapeHtml(item.previewDmMessage || '');
      const simulatedAction = escapeHtml(item.simulatedAction || '-');
      const debugCount = Array.isArray(item.debugSteps) ? item.debugSteps.length : 0;
      const statusClass = (item.status === 'connect_sent' || item.status === 'dm_sent')
        ? 'sent'
        : item.status === 'failed' ? 'failed' : 'preview';
      const statusText = escapeHtml(item.status || 'unknown');

      return `
        <div class="status-item">
          <div><strong>Company:</strong> ${company}</div>
          <div><strong>Receiver:</strong> ${receiver}</div>
          <div class="status-tag ${statusClass}">${statusText}</div>
          <div><strong>Profile:</strong> ${profile}</div>
          <div><strong>Dry Run Decision:</strong> ${simulatedAction}</div>
          <div><strong>Detail:</strong> ${detail}</div>
          <div><strong>Rendered Connect Template:</strong> ${previewConnectMessage || '-'}</div>
          <div><strong>Rendered DM Template:</strong> ${previewDmMessage || '-'}</div>
          <div><strong>Debug Steps:</strong> ${debugCount}</div>
          <div><strong>Screenshot:</strong> ${screenshot || '-'}</div>
        </div>
      `;
    })
    .join('');
}

function saveFormState() {
  const data = {
    connectTemplate: form.connectTemplate.value,
    dmTemplate: form.dmTemplate.value,
    delayMs: form.delayMs.value,
    maxActions: form.maxActions.value,
    freshSession: form.freshSession.value
    // li_at cookie intentionally NOT saved to localStorage for security
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function restoreFormState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    if (data.connectTemplate) form.connectTemplate.value = data.connectTemplate;
    if (data.dmTemplate) form.dmTemplate.value = data.dmTemplate;
    if (data.delayMs) form.delayMs.value = data.delayMs;
    if (data.maxActions) form.maxActions.value = data.maxActions;
    if (data.freshSession) form.freshSession.value = data.freshSession;
  } catch (_error) {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function updateFileStateText() {
  const currentFile = leadsFileInput.files[0] || persistedFile;
  if (!currentFile) {
    fileState.textContent = 'No file selected.';
    return;
  }

  const source = leadsFileInput.files[0] ? 'selected now' : 'restored after reload';
  fileState.textContent = `${currentFile.name} (${source})`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFileToDb(file) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put(file, FILE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadFileFromDb() {
  const db = await openDb();
  const file = await new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const request = tx.objectStore(FILE_STORE).get(FILE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return file;
}

async function clearFileFromDb() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).delete(FILE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function restoreInputFile(file) {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    leadsFileInput.files = dt.files;
  } catch (_error) {
    // Some browsers block programmatic assignment; fallback is persistedFile usage.
  }
}

async function restorePersistedFile() {
  const metaRaw = localStorage.getItem(FILE_META_KEY);
  if (!metaRaw) {
    updateFileStateText();
    return;
  }

  const dbFile = await loadFileFromDb();
  if (!dbFile) {
    localStorage.removeItem(FILE_META_KEY);
    updateFileStateText();
    return;
  }

  persistedFile = dbFile;
  restoreInputFile(dbFile);
  updateFileStateText();
}

function getCurrentFile() {
  return leadsFileInput.files[0] || persistedFile;
}

async function callApi(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

function buildLinkedinFormData(file) {
  const formData = new FormData();
  formData.append('leadsFile', file, file.name);
  formData.append('connectTemplate', form.connectTemplate.value);
  formData.append('dmTemplate', form.dmTemplate.value);
  formData.append('delayMs', form.delayMs.value);
  formData.append('maxActions', form.maxActions.value);
  formData.append('freshSession', form.freshSession.value);
  const cookie = document.getElementById('liAtCookie').value.trim();
  if (cookie) formData.append('liAtCookie', cookie);
  return formData;
}

async function pollJob(jobId) {
  const job = await callApi(`/api/linkedin/job/${jobId}`, { method: 'GET' });
  const msg = `Status: ${job.status}. Processed ${job.processed}/${job.total}. Sent ${job.sentConnectRequests}, Skipped ${job.skipped}, Failed ${job.failed}.`;
  setStatusMessage(msg);
  renderStatusList(job.results || []);

  if (job.status === 'running') {
    pollTimer = setTimeout(() => {
      pollJob(jobId).catch((error) => setStatusMessage(`Polling failed: ${error.message}`));
    }, 2500);
  } else {
    activeJobId = null;
    pollTimer = null;
    let finalMsg = `${msg} Log: ${job.logFile} Debug: ${job.debugLogFile || '-'} Artifacts: ${job.artifactsDir || '-'}`;
    if (job.error) finalMsg = `Error: ${job.error}\n\n${finalMsg}`;
    setStatusMessage(finalMsg);
  }
}

form.addEventListener('input', saveFormState);
form.addEventListener('change', saveFormState);

leadsFileInput.addEventListener('change', async () => {
  const file = leadsFileInput.files[0];
  if (!file) {
    persistedFile = null;
    localStorage.removeItem(FILE_META_KEY);
    await clearFileFromDb();
    updateFileStateText();
    return;
  }

  persistedFile = file;
  await saveFileToDb(file);
  localStorage.setItem(FILE_META_KEY, JSON.stringify({ name: file.name, size: file.size }));
  updateFileStateText();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    if (activeJobId) {
      throw new Error('A job is already running. Wait until it finishes.');
    }

    const file = getCurrentFile();
    if (!file) {
      throw new Error('Please upload an Excel file first.');
    }

    const cookie = document.getElementById('liAtCookie').value.trim();
    const isCloud = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    if (isCloud && !cookie) {
      throw new Error(
        'Step 4 required: paste your li_at cookie before starting. ' +
        'Chrome → F12 → Application → Cookies → linkedin.com → li_at → copy Value.'
      );
    }

    const formData = buildLinkedinFormData(file);

    setStatusMessage('Starting LinkedIn automation job...');
    renderStatusList([]);

    const result = await callApi('/api/linkedin/start', {
      method: 'POST',
      body: formData
    });

    activeJobId = result.jobId;
    setStatusMessage(
      `Job started (${result.jobId}). Profiles found: ${result.totalProfiles}. This run capped at ${result.cappedTo}. Debug: ${result.debugLogFile || '-'}`
    );

    await pollJob(result.jobId);
  } catch (error) {
    setStatusMessage(`Start failed: ${error.message}`);
  }
});

dryRunBtn.addEventListener('click', async () => {
  try {
    if (activeJobId) {
      throw new Error('A job is already running. Wait until it finishes.');
    }
    const file = getCurrentFile();
    if (!file) {
      throw new Error('Please upload an Excel file first.');
    }

    setStatusMessage('Building dry run preview...');
    const formData = buildLinkedinFormData(file);
    const result = await callApi('/api/linkedin/dry-run', {
      method: 'POST',
      body: formData
    });

    setStatusMessage(
      `Dry run ready. Previewed ${result.previewCount}/${result.totalProfiles} (cap ${result.cappedTo}). Connect-preview ${result.connectPreviewCount}, DM-preview ${result.dmPreviewCount}, Skip-preview ${result.skippedPreviewCount}.`
    );
    renderStatusList(result.results || []);
  } catch (error) {
    setStatusMessage(`Dry run failed: ${error.message}`);
  }
});

resetBtn.addEventListener('click', async () => {
  await clearFileFromDb();
  form.reset();
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(FILE_META_KEY);
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  persistedFile = null;
  pollTimer = null;
  activeJobId = null;
  setStatusMessage('Reset complete.');
  renderStatusList([]);
  updateFileStateText();
});

async function init() {
  restoreFormState();
  renderStatusList([]);
  await restorePersistedFile();
}

init();
