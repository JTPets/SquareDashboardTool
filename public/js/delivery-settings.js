/**
 * Delivery Settings page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

let currentSettings = {};

async function loadSettings() {
  try {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('settingsForm').style.display = 'none';

    const response = await fetch('/api/delivery/settings');
    if (!response.ok) throw new Error('Failed to load settings');

    const data = await response.json();
    currentSettings = data.settings;

    // Populate form
    document.getElementById('startAddress').value = currentSettings.start_address || '';
    document.getElementById('endAddress').value = currentSettings.end_address || '';
    document.getElementById('sameDayCutoff').value = currentSettings.same_day_cutoff || '17:00';
    document.getElementById('autoIngestReadyOrders').checked = currentSettings.auto_ingest_ready_orders !== false;
    document.getElementById('podRetentionDays').value = currentSettings.pod_retention_days || 180;
    document.getElementById('openrouteserviceApiKey').value = ''; // Don't show existing key

    // Show geocode status
    updateGeocodeStatus('startAddress', currentSettings.start_address_lat, currentSettings.start_address_lng);
    updateGeocodeStatus('endAddress', currentSettings.end_address_lat, currentSettings.end_address_lng);

    document.getElementById('loading').style.display = 'none';
    document.getElementById('settingsForm').style.display = 'block';
  } catch (error) {
    console.error('Error loading settings:', error);
    showMessage('Failed to load settings: ' + error.message, 'error');
    document.getElementById('loading').style.display = 'none';
  }
}

function updateGeocodeStatus(field, lat, lng) {
  const statusEl = document.getElementById(field + 'Status');
  const inputEl = document.getElementById(field);

  if (!inputEl.value) {
    statusEl.innerHTML = '';
    return;
  }

  if (lat && lng) {
    statusEl.innerHTML = `<span class="geocode-status success">Geocoded (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})</span>`;
  } else {
    statusEl.innerHTML = `<span class="geocode-status pending">Will be geocoded on save</span>`;
  }
}

async function saveSettings(e) {
  e.preventDefault();

  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const settings = {
      startAddress: document.getElementById('startAddress').value || null,
      endAddress: document.getElementById('endAddress').value || null,
      sameDayCutoff: document.getElementById('sameDayCutoff').value,
      autoIngestReadyOrders: document.getElementById('autoIngestReadyOrders').checked,
      podRetentionDays: parseInt(document.getElementById('podRetentionDays').value),
    };

    // Only include API key if a new one was entered
    const apiKey = document.getElementById('openrouteserviceApiKey').value;
    if (apiKey) {
      settings.openrouteserviceApiKey = apiKey;
    }

    const response = await fetch('/api/delivery/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to save settings');
    }

    const data = await response.json();
    currentSettings = data.settings;

    // Update geocode status
    updateGeocodeStatus('startAddress', currentSettings.start_address_lat, currentSettings.start_address_lng);
    updateGeocodeStatus('endAddress', currentSettings.end_address_lat, currentSettings.end_address_lng);

    showMessage('Settings saved successfully!', 'success');
  } catch (error) {
    console.error('Error saving settings:', error);
    showMessage('Failed to save settings: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

function showMessage(text, type) {
  const messageEl = document.getElementById('message');
  messageEl.innerHTML = `<div class="alert ${type}">${text}</div>`;
  setTimeout(() => { messageEl.innerHTML = ''; }, 5000);
}

// Event listeners
document.getElementById('settingsForm').addEventListener('submit', saveSettings);

document.getElementById('startAddress').addEventListener('blur', function() {
  if (this.value !== currentSettings.start_address) {
    updateGeocodeStatus('startAddress', null, null);
  }
});

document.getElementById('endAddress').addEventListener('blur', function() {
  if (this.value !== currentSettings.end_address) {
    updateGeocodeStatus('endAddress', null, null);
  }
});

// Load settings on page load
loadSettings();

// Expose functions to global scope for event delegation
window.loadSettings = loadSettings;
