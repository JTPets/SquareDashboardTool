/**
 * System Logs page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

// escapeHtml is loaded globally from public/js/utils/escape.js

let allLogs = [];
let refreshInterval;
let countdownInterval;
let secondsRemaining = 60;
const REFRESH_INTERVAL_SEC = 60;

// Load logs and stats on page load
async function loadStats() {
  try {
    const response = await fetch('/api/logs/stats');
    const data = await response.json();

    document.getElementById('stat-total').textContent = (data.total || 0).toLocaleString();
    document.getElementById('stat-errors').textContent = (data.errors || 0).toLocaleString();
    document.getElementById('stat-warnings').textContent = (data.warnings || 0).toLocaleString();
    document.getElementById('stat-info').textContent = (data.info || 0).toLocaleString();
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

async function loadLogs() {
  try {
    const limit = document.getElementById('limit-select').value;
    const response = await fetch(`/api/logs?limit=${limit}`);
    const data = await response.json();

    allLogs = data.logs || [];
    filterLogs();
  } catch (error) {
    const errDiv = document.getElementById('logs-content');
    errDiv.textContent = '';
    const errMsg = document.createElement('div');
    errMsg.className = 'error-message';
    errMsg.textContent = 'Failed to load logs: ' + error.message;
    errDiv.appendChild(errMsg);
  }
}

function filterLogs() {
  const levelFilter = document.getElementById('level-filter').value;

  let filteredLogs = allLogs;
  if (levelFilter !== 'all') {
    filteredLogs = allLogs.filter(log => log.level === levelFilter);
  }

  if (filteredLogs.length === 0) {
    document.getElementById('logs-content').innerHTML =
      '<div class="loading">No logs found matching the filter criteria.</div>';
    return;
  }

  const tableHTML = `
    <table class="logs-table">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Level</th>
          <th>Message</th>
          <th>Service</th>
        </tr>
      </thead>
      <tbody>
        ${filteredLogs.map(log => `
          <tr>
            <td class="log-timestamp">${escapeHtml(log.timestamp || '--')}</td>
            <td><span class="log-level ${escapeHtml(log.level || '')}">${escapeHtml(log.level || '')}</span></td>
            <td class="log-message">${escapeHtml(log.message || '')}</td>
            <td>${escapeHtml(log.service || 'square-dashboard-addon')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  document.getElementById('logs-content').innerHTML = tableHTML;
}

async function refreshLogs() {
  await Promise.all([loadStats(), loadLogs()]);
  resetCountdown();
}

async function testEmail(element) {
  // Element passed by PageActions event delegation
  const btn = element;
  btn.disabled = true;
  btn.textContent = '⏳ Sending...';

  try {
    const response = await fetch('/api/test-email', { method: 'POST' });
    const data = await response.json();

    if (response.ok) {
      showMessage('success', data.message || 'Test email sent successfully!');
    } else {
      showMessage('error', data.error || 'Failed to send test email');
    }
  } catch (error) {
    showMessage('error', 'Failed to send test email: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✉️ Test Email';
  }
}

function showMessage(type, text) {
  const messageDiv = document.createElement('div');
  messageDiv.className = type === 'success' ? 'success-message' : 'error-message';
  messageDiv.textContent = text;

  const container = document.getElementById('message-container');
  container.innerHTML = '';
  container.appendChild(messageDiv);

  if (type === 'success') {
    setTimeout(() => messageDiv.remove(), 3000);
  }
}

function resetCountdown() {
  secondsRemaining = REFRESH_INTERVAL_SEC;
  document.getElementById('countdown').textContent = secondsRemaining;
}

function updateCountdown() {
  secondsRemaining--;
  document.getElementById('countdown').textContent = secondsRemaining;

  if (secondsRemaining <= 0) {
    refreshLogs();
  }
}

function startPolling() {
  if (!refreshInterval) {
    refreshInterval = setInterval(refreshLogs, REFRESH_INTERVAL_SEC * 1000);
  }
  if (!countdownInterval) {
    countdownInterval = setInterval(updateCountdown, 1000);
  }
}

function stopPolling() {
  clearInterval(refreshInterval);
  clearInterval(countdownInterval);
  refreshInterval = null;
  countdownInterval = null;
}

// Pause polling when tab is hidden, resume when visible
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    refreshLogs();
    startPolling();
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  refreshLogs();
  startPolling();
  checkAdminAccess();
});

// Cleanup intervals when page unloads
window.addEventListener('beforeunload', () => {
  stopPolling();
});

// ==================== Location Health Tab ====================

async function checkAdminAccess() {
  try {
    const response = await fetch('/api/admin/catalog-location-health');
    if (response.ok) {
      const tabBtn = document.getElementById('tab-btn-location-health');
      if (tabBtn) tabBtn.style.display = '';
    }
  } catch (e) {
    // Not admin — tab stays hidden
  }
}

function switchTab(element) {
  const tabName = element.getAttribute('data-tab');
  if (!tabName) return;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.classList.remove('active');
  });
  element.classList.add('active');

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(function(content) {
    content.classList.remove('active');
  });
  var tabEl = document.getElementById('tab-' + tabName);
  if (tabEl) tabEl.classList.add('active');

  // Load location health data on first switch
  if (tabName === 'location-health') {
    refreshLocationHealth();
  }
}

async function refreshLocationHealth() {
  try {
    const response = await fetch('/api/admin/catalog-location-health');
    if (!response.ok) {
      document.getElementById('open-mismatches-content').innerHTML =
        '<div class="error-message">Failed to load health data</div>';
      return;
    }
    const data = await response.json();
    renderOpenMismatches(data.openMismatches || []);
    renderHealthHistory(data.history || []);
  } catch (error) {
    document.getElementById('open-mismatches-content').innerHTML =
      '<div class="error-message">Failed to load: ' + escapeHtml(error.message) + '</div>';
  }
}

function renderOpenMismatches(mismatches) {
  var container = document.getElementById('open-mismatches-content');
  if (mismatches.length === 0) {
    container.innerHTML = '<div class="loading">No open mismatches found.</div>';
    return;
  }

  container.innerHTML = '<table class="logs-table"><thead><tr>' +
    '<th>Variation ID</th><th>Item ID</th><th>Mismatch Type</th><th>Detected At</th>' +
    '</tr></thead><tbody>' +
    mismatches.map(function(row) {
      return '<tr>' +
        '<td class="log-message">' + escapeHtml(row.variation_id) + '</td>' +
        '<td class="log-message">' + escapeHtml(row.item_id) + '</td>' +
        '<td>' + escapeHtml(row.mismatch_type || '') + '</td>' +
        '<td class="log-timestamp">' + escapeHtml(row.detected_at || '') + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table>';
}

function renderHealthHistory(history) {
  var container = document.getElementById('health-history-content');
  if (history.length === 0) {
    container.innerHTML = '<div class="loading">No history found.</div>';
    return;
  }

  container.innerHTML = '<table class="logs-table"><thead><tr>' +
    '<th>Status</th><th>Variation ID</th><th>Item ID</th><th>Mismatch Type</th>' +
    '<th>Detected At</th><th>Resolved At</th>' +
    '</tr></thead><tbody>' +
    history.map(function(row) {
      var badgeClass = row.status === 'mismatch' ? 'mismatch' : 'valid';
      return '<tr>' +
        '<td><span class="status-badge ' + badgeClass + '">' + escapeHtml(row.status) + '</span></td>' +
        '<td class="log-message">' + escapeHtml(row.variation_id) + '</td>' +
        '<td class="log-message">' + escapeHtml(row.item_id) + '</td>' +
        '<td>' + escapeHtml(row.mismatch_type || '') + '</td>' +
        '<td class="log-timestamp">' + escapeHtml(row.detected_at || '') + '</td>' +
        '<td class="log-timestamp">' + escapeHtml(row.resolved_at || '--') + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table>';
}

async function runHealthCheck(element) {
  var btn = element;
  btn.disabled = true;
  btn.textContent = 'Running...';

  try {
    var response = await fetch('/api/admin/catalog-location-health/check', { method: 'POST' });
    var data = await response.json();

    if (response.ok) {
      var resultDiv = document.getElementById('health-check-result');
      resultDiv.style.display = '';
      resultDiv.textContent = 'Checked: ' + (data.checked || 0) +
        ' | New mismatches: ' + (data.newMismatches || 0) +
        ' | Resolved: ' + (data.resolved || 0) +
        ' | Existing open: ' + (data.existingOpen || 0);
      await refreshLocationHealth();
    } else {
      showMessage('error', data.error || 'Health check failed');
    }
  } catch (error) {
    showMessage('error', 'Health check failed: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Check Now';
  }
}

// Expose functions to global scope for event delegation
window.refreshLogs = refreshLogs;
window.filterLogs = filterLogs;
window.testEmail = testEmail;
window.switchTab = switchTab;
window.refreshLocationHealth = refreshLocationHealth;
window.runHealthCheck = runHealthCheck;
