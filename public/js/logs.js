/**
 * System Logs page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

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
    document.getElementById('logs-content').innerHTML =
      '<div class="error-message">Failed to load logs: ' + error.message + '</div>';
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
            <td class="log-timestamp">${log.timestamp || '--'}</td>
            <td><span class="log-level ${log.level}">${log.level}</span></td>
            <td class="log-message">${escapeHtml(log.message || '')}</td>
            <td>${log.service || 'square-dashboard-addon'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  document.getElementById('logs-content').innerHTML = tableHTML;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
});

// Cleanup intervals when page unloads
window.addEventListener('beforeunload', () => {
  stopPolling();
});

// Expose functions to global scope for event delegation
window.refreshLogs = refreshLogs;
window.filterLogs = filterLogs;
window.testEmail = testEmail;
