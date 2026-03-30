const form = document.getElementById('campaignForm');
const previewBtn = document.getElementById('previewBtn');
const statusEl = document.getElementById('status');

function setStatus(message, data) {
  const payload = data ? `\n${JSON.stringify(data, null, 2)}` : '';
  statusEl.textContent = `${message}${payload}`;
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

previewBtn.addEventListener('click', async () => {
  try {
    setStatus('Reading Excel preview...');
    const formData = new FormData();
    const file = form.leadsFile.files[0];
    if (!file) {
      throw new Error('Please select an Excel file first.');
    }

    formData.append('leadsFile', file);
    const result = await callApi('/api/preview', formData);
    setStatus('Preview loaded.', result);
  } catch (error) {
    setStatus(`Preview failed: ${error.message}`);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    setStatus('Starting campaign. Sending emails one by one...');
    const formData = new FormData(form);
    const result = await callApi('/api/send-campaign', formData);
    setStatus('Campaign completed.', result);
  } catch (error) {
    setStatus(`Campaign failed: ${error.message}`);
  }
});
