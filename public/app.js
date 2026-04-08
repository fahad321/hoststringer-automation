const form = document.getElementById('campaignForm');
const previewBtn = document.getElementById('previewBtn');
const resetBtn = document.getElementById('resetBtn');
const leadsFileInput = document.getElementById('leadsFileInput');
const fileState = document.getElementById('fileState');
const statusMessageEl = document.getElementById('statusMessage');
const statusListEl = document.getElementById('statusList');

const FORM_STORAGE_KEY = 'hoststringer_form_state_v1';
const STATUS_STORAGE_KEY = 'hoststringer_status_state_v1';
const FILE_META_KEY = 'hoststringer_file_meta_v1';
const DB_NAME = 'hoststringer_campaign_db';
const FILE_STORE = 'files';
const FILE_KEY = 'leads_file';

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
    statusListEl.innerHTML = '<div class="status-item"><strong>No campaign results yet.</strong></div>';
    return;
  }

  statusListEl.innerHTML = results
    .map((item) => {
      const company = escapeHtml(item.companyName || '-');
      const receiver = escapeHtml(item.receiverName || item.email || '-');
      const statusClass = item.status === 'sent'
        ? 'sent'
        : item.status === 'failed'
          ? 'failed'
          : 'preview';
      const statusText = escapeHtml(item.status || 'unknown');
      return `
        <div class="status-item">
          <div><strong>Company:</strong> ${company}</div>
          <div><strong>Receiver:</strong> ${receiver}</div>
          <div class="status-tag ${statusClass}">${statusText}</div>
        </div>
      `;
    })
    .join('');
}

function saveFormState() {
  const data = {};
  const fields = new FormData(form);

  for (const [key, value] of fields.entries()) {
    if (key !== 'leadsFile') {
      data[key] = value;
    }
  }

  localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(data));
}

function restoreFormState() {
  const raw = localStorage.getItem(FORM_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const data = JSON.parse(raw);
    for (const [key, value] of Object.entries(data)) {
      const field = form.elements.namedItem(key);
      if (field && 'value' in field) {
        field.value = value;
      }
    }
  } catch (_error) {
    localStorage.removeItem(FORM_STORAGE_KEY);
  }
}

function saveStatusState(message, results) {
  localStorage.setItem(
    STATUS_STORAGE_KEY,
    JSON.stringify({
      message,
      results: results || []
    })
  );
}

function restoreStatusState() {
  const raw = localStorage.getItem(STATUS_STORAGE_KEY);
  if (!raw) {
    renderStatusList([]);
    return;
  }

  try {
    const data = JSON.parse(raw);
    setStatusMessage(data.message || 'Ready.');
    renderStatusList(Array.isArray(data.results) ? data.results : []);
  } catch (_error) {
    setStatusMessage('Ready.');
    renderStatusList([]);
  }
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

function updateFileStateText() {
  const currentFile = leadsFileInput.files[0] || persistedFile;
  if (!currentFile) {
    fileState.textContent = 'No file selected.';
    return;
  }

  const source = leadsFileInput.files[0] ? 'selected now' : 'restored after reload';
  fileState.textContent = `${currentFile.name} (${source})`;
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

async function callApi(url, formData) {
  const response = await fetch(url, {
    method: 'POST',
    body: formData
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }

  return payload;
}

function getCurrentFile() {
  return leadsFileInput.files[0] || persistedFile;
}

function buildFormData() {
  const formData = new FormData();
  const fieldNames = [
    'hostingerServerUrl',
    'smtpPort',
    'smtpSecure',
    'hostingerEmail',
    'hostingerPassword',
    'fromName',
    'subjectTemplate',
    'bodyTemplate',
    'delayMs'
  ];

  for (const fieldName of fieldNames) {
    const field = form.elements.namedItem(fieldName);
    formData.append(fieldName, field ? field.value : '');
  }

  const file = getCurrentFile();
  if (file) {
    formData.append('leadsFile', file, file.name || 'leads.xlsx');
  }

  return formData;
}

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

form.addEventListener('input', saveFormState);
form.addEventListener('change', saveFormState);

previewBtn.addEventListener('click', async () => {
  try {
    setStatusMessage('Reading Excel preview...');
    const file = getCurrentFile();
    if (!file) {
      throw new Error('Please select an Excel file first.');
    }

    const formData = new FormData();
    formData.append('leadsFile', file, file.name || 'leads.xlsx');
    const result = await callApi('/api/preview', formData);

    const previewRows = result.preview || [];
    const list = previewRows.map((row) => ({
      companyName: row.company_name || row.company || '-',
      receiverName: row.name || row.first_name || row.email || '-',
      status: 'preview'
    }));

    setStatusMessage(`Preview loaded. ${result.totalRows} rows detected.`);
    renderStatusList(list);
    saveStatusState(`Preview loaded. ${result.totalRows} rows detected.`, list);
  } catch (error) {
    setStatusMessage(`Preview failed: ${error.message}`);
    renderStatusList([]);
    saveStatusState(`Preview failed: ${error.message}`, []);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    setStatusMessage('Starting campaign. Sending emails one by one...');
    const result = await callApi('/api/send-campaign', buildFormData());
    const msg = `Campaign completed. Sent: ${result.sentCount}, Failed: ${result.failedCount}`;
    setStatusMessage(msg);
    renderStatusList(result.results || []);
    saveStatusState(msg, result.results || []);
  } catch (error) {
    setStatusMessage(`Campaign failed: ${error.message}`);
    saveStatusState(`Campaign failed: ${error.message}`, []);
  }
});

resetBtn.addEventListener('click', async () => {
  form.reset();
  persistedFile = null;
  localStorage.removeItem(FORM_STORAGE_KEY);
  localStorage.removeItem(STATUS_STORAGE_KEY);
  localStorage.removeItem(FILE_META_KEY);
  await clearFileFromDb();
  setStatusMessage('Reset complete.');
  renderStatusList([]);
  updateFileStateText();
});

async function init() {
  restoreFormState();
  restoreStatusState();
  await restorePersistedFile();
}

init();
