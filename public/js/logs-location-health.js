/**
 * Location Health tab on the System Logs page.
 * Split out of public/js/logs.js to keep that file under 300 lines.
 *
 * Depends on: escapeHtml (from utils/escape.js), showMessage (from logs.js)
 */

async function checkAdminAccess() {
  try {
    const response = await fetch('/api/admin/catalog-health');
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

  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.classList.remove('active');
  });
  element.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(function(content) {
    content.classList.remove('active');
  });
  var tabEl = document.getElementById('tab-' + tabName);
  if (tabEl) tabEl.classList.add('active');

  if (tabName === 'location-health') {
    refreshLocationHealth();
  }
}

async function refreshLocationHealth() {
  try {
    const response = await fetch('/api/admin/catalog-health');
    if (!response.ok) {
      document.getElementById('open-mismatches-content').innerHTML =
        '<div class="error-message">Failed to load health data</div>';
      return;
    }
    const data = await response.json();
    renderOpenMismatches(data.openIssues || data.openMismatches || []);
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
    var response = await fetch('/api/admin/catalog-health/check', { method: 'POST' });
    var data = await response.json();

    if (response.ok) {
      var resultDiv = document.getElementById('health-check-result');
      resultDiv.style.display = '';
      var checkedCount = data.checked ? (data.checked.items || 0) + (data.checked.variations || 0) : (data.checked || 0);
      var newCount = data.newIssues ? data.newIssues.length : (data.newMismatches || 0);
      var resolvedCount = data.resolved ? data.resolved.length : (data.resolved || 0);
      resultDiv.textContent = 'Checked: ' + checkedCount +
        ' | New issues: ' + newCount +
        ' | Resolved: ' + resolvedCount +
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
window.checkAdminAccess = checkAdminAccess;
window.switchTab = switchTab;
window.refreshLocationHealth = refreshLocationHealth;
window.runHealthCheck = runHealthCheck;
