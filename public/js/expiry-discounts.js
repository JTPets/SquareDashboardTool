/**
 * Expiry Discounts page JavaScript
 * Externalized from expiry-discounts.html for CSP compliance (P0-4 Phase 2)
 */

// State
let currentTierFilter = null;
let statusData = null;

function switchTab(element, event, tabName) {
  // Support both direct call and event delegation
  if (typeof element === 'string') {
    tabName = element;
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');

  if (tabName === 'upcoming') {
    loadUpcoming();
  }
}

function filterByTier(element, event, tierCode) {
  // Support both direct call and event delegation
  if (typeof element === 'string') {
    tierCode = element;
  }
  // Toggle filter
  if (currentTierFilter === tierCode) {
    currentTierFilter = null;
    document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('active'));
  } else {
    currentTierFilter = tierCode;
    document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('active'));
    document.querySelector(`.tier-card[data-tier="${tierCode}"]`).classList.add('active');
  }
  loadItems();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/expiry-discounts/status');
    statusData = await response.json();

    // Update tier counts
    for (const tier of statusData.tiers) {
      const countEl = document.getElementById(`count-${tier.tier_code}`);
      if (countEl) {
        countEl.textContent = tier.variation_count || 0;
      }
    }

    // Update totals
    document.getElementById('total-discounted').textContent = statusData.totalWithDiscounts || 0;
    document.getElementById('total-needs-pull').textContent = statusData.totalNeedingPull || 0;

    // Update last run
    if (statusData.lastRunAt) {
      const lastRun = new Date(statusData.lastRunAt);
      document.getElementById('last-run').textContent = lastRun.toLocaleString();
    }

    // Update status bar
    const statusBar = document.getElementById('status-bar');
    const statusMessage = document.getElementById('status-message');

    if (statusData.totalNeedingPull > 0) {
      statusBar.className = 'status-bar error';
      statusMessage.innerHTML = `<strong>${statusData.totalNeedingPull} item(s) need to be pulled from shelves!</strong>`;
    } else if (statusData.totalWithDiscounts > 0) {
      statusBar.className = 'status-bar warning';
      statusMessage.textContent = `${statusData.totalWithDiscounts} items currently have expiry discounts applied.`;
    } else {
      statusBar.className = 'status-bar';
      statusMessage.textContent = 'All items are within normal expiry range.';
    }

  } catch (error) {
    console.error('Failed to load status:', error);
  }
}

async function loadItems() {
  const tbody = document.getElementById('items-table-body');
  tbody.innerHTML = '<tr><td colspan="9" class="loading"><div class="spinner"></div><br>Loading...</td></tr>';

  try {
    let url = '/api/expiry-discounts/variations?limit=500';
    if (currentTierFilter) {
      url += `&tier_code=${currentTierFilter}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.variations.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No items found. Run evaluation to assign tiers.</td></tr>';
      return;
    }

    tbody.innerHTML = data.variations.map(item => {
      const daysClass = getDaysClass(item.days_until_expiry);
      const expiryDate = item.expiration_date
        ? new Date(item.expiration_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '-';
      const originalPrice = item.original_price_cents ? '$' + (item.original_price_cents / 100).toFixed(2) : '-';
      const discountedPrice = item.discounted_price_cents ? '$' + (item.discounted_price_cents / 100).toFixed(2) : '-';

      // Check if item has 0 available to sell
      const availableToSell = item.available_to_sell || 0;
      const isOutOfStock = availableToSell <= 0;
      const rowClass = isOutOfStock ? 'out-of-stock' : '';
      const zeroAvailableBadge = isOutOfStock ? '<span class="zero-available">0 AVAIL</span>' : '';

      let statusHtml = '';
      if (item.needs_pull) {
        statusHtml = '<span class="needs-pull">PULL</span>';
      } else if (item.discount_applied_at) {
        statusHtml = '<span style="color: #059669; font-weight: 600;">Active</span>';
      } else if (item.requires_review) {
        statusHtml = '<span style="color: #3b82f6;">Review</span>';
      } else {
        statusHtml = '<span style="color: #6b7280;">-</span>';
      }

      return `
        <tr class="${rowClass}" title="${isOutOfStock ? '0 available to sell - not on shelf' : ''}">
          <td><span class="tier-badge tier-${item.tier_code}">${item.tier_code}</span>${zeroAvailableBadge}</td>
          <td>
            <strong>${escapeHtml(item.item_name)}</strong>
            ${item.variation_name ? `<br><small style="color: #6b7280;">${escapeHtml(item.variation_name)}</small>` : ''}
          </td>
          <td style="font-family: monospace; font-size: 12px;">${escapeHtml(item.sku || '-')}</td>
          <td><span class="days-badge ${daysClass}">${item.days_until_expiry !== null ? item.days_until_expiry + 'd' : '-'}</span></td>
          <td>${expiryDate}</td>
          <td class="text-right">${availableToSell}</td>
          <td class="text-right">${originalPrice}</td>
          <td class="text-right" style="font-weight: 600; color: ${item.discounted_price_cents ? '#dc2626' : '#6b7280'};">${discountedPrice}</td>
          <td>${statusHtml}</td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Failed to load items:', error);
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Failed to load items. Please try again.</td></tr>';
  }
}

async function loadUpcoming() {
  const tbody = document.getElementById('upcoming-table-body');

  try {
    const response = await fetch('/api/expiry-discounts/variations?limit=500');
    const data = await response.json();

    // Filter to items approaching tier boundaries
    const upcoming = data.variations.filter(item => {
      const days = item.days_until_expiry;
      if (days === null) return false;

      // Check if within 5 days of a tier boundary
      const boundaries = [0, 30, 89, 120];
      return boundaries.some(b => days > b && days <= b + 5);
    });

    if (upcoming.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No items approaching tier changes in the next 5 days.</td></tr>';
      return;
    }

    tbody.innerHTML = upcoming.map(item => {
      const days = item.days_until_expiry;
      let nextTier = 'OK';
      let daysUntilChange = 0;

      if (days > 0 && days <= 35) {
        nextTier = 'AUTO50';
        daysUntilChange = days - 30;
      } else if (days > 30 && days <= 94) {
        nextTier = 'AUTO25';
        daysUntilChange = days - 89;
      } else if (days > 89 && days <= 125) {
        nextTier = 'REVIEW';
        daysUntilChange = days - 120;
      }

      return `
        <tr>
          <td><strong>${escapeHtml(item.item_name)}</strong></td>
          <td style="font-family: monospace;">${escapeHtml(item.sku || '-')}</td>
          <td><span class="tier-badge tier-${item.tier_code}">${item.tier_code}</span></td>
          <td>${days}d</td>
          <td><span class="tier-badge tier-${nextTier}">${nextTier}</span></td>
          <td>${daysUntilChange > 0 ? daysUntilChange + ' days' : 'Today'}</td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Failed to load upcoming:', error);
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load upcoming changes.</td></tr>';
  }
}

async function loadAuditLog() {
  const tbody = document.getElementById('audit-table-body');

  try {
    const response = await fetch('/api/expiry-discounts/audit-log?limit=100');
    const data = await response.json();

    if (data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No audit log entries yet.</td></tr>';
      return;
    }

    tbody.innerHTML = data.logs.map(log => {
      const timestamp = new Date(log.created_at).toLocaleString();
      return `
        <tr>
          <td style="font-size: 12px; color: #6b7280;">${timestamp}</td>
          <td><span class="audit-action ${log.action}">${log.action}</span></td>
          <td>${escapeHtml(log.item_name || '-')}</td>
          <td style="font-family: monospace; font-size: 12px;">${escapeHtml(log.sku || '-')}</td>
          <td>${log.old_tier_code ? `<span class="tier-badge tier-${log.old_tier_code}">${log.old_tier_code}</span>` : '-'}</td>
          <td>${log.new_tier_code ? `<span class="tier-badge tier-${log.new_tier_code}">${log.new_tier_code}</span>` : '-'}</td>
          <td>${log.days_until_expiry !== null ? log.days_until_expiry + 'd' : '-'}</td>
          <td style="font-size: 12px;">${log.triggered_by}</td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Failed to load audit log:', error);
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load audit log.</td></tr>';
  }
}

async function loadSettings() {
  try {
    const response = await fetch('/api/expiry-discounts/settings');
    const data = await response.json();

    for (const [key, setting] of Object.entries(data.settings)) {
      const el = document.getElementById(`setting-${key}`);
      if (el) {
        if (el.type === 'checkbox') {
          el.checked = setting.value === 'true';
        } else {
          el.value = setting.value || '';
        }
      }
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function loadTierConfig() {
  const tbody = document.getElementById('tier-config-body');

  try {
    const response = await fetch('/api/expiry-discounts/tiers');
    const data = await response.json();

    tbody.innerHTML = data.tiers.map(tier => `
      <tr data-tier-id="${tier.id}">
        <td><span class="tier-badge tier-${tier.tier_code}">${tier.tier_code}</span></td>
        <td><input type="text" value="${tier.tier_name || ''}" data-field="tier_name" placeholder="Display name" style="width: 160px;"></td>
        <td><input type="number" value="${tier.min_days_to_expiry ?? ''}" data-field="min_days_to_expiry" placeholder="None" style="width: 70px;"></td>
        <td><input type="number" value="${tier.max_days_to_expiry ?? ''}" data-field="max_days_to_expiry" placeholder="None" style="width: 70px;"></td>
        <td><input type="number" value="${tier.discount_percent}" data-field="discount_percent" min="0" max="100" step="1" style="width: 70px;"></td>
        <td class="text-center"><input type="checkbox" ${tier.is_auto_apply ? 'checked' : ''} data-field="is_auto_apply"></td>
        <td class="text-center"><input type="checkbox" ${tier.requires_review ? 'checked' : ''} data-field="requires_review"></td>
        <td><button class="btn-primary" style="padding: 4px 12px; font-size: 12px;" data-action="saveTierConfig" data-action-param="${tier.id}">Save</button></td>
      </tr>
    `).join('');

  } catch (error) {
    console.error('Failed to load tier config:', error);
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load tier configuration.</td></tr>';
  }
}

async function saveSettings() {
  const updates = {
    cron_schedule: document.getElementById('setting-cron_schedule').value,
    timezone: document.getElementById('setting-timezone').value,
    auto_apply_enabled: document.getElementById('setting-auto_apply_enabled').checked ? 'true' : 'false',
    email_notifications: document.getElementById('setting-email_notifications').checked ? 'true' : 'false'
  };

  try {
    const response = await fetch('/api/expiry-discounts/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    if (response.ok) {
      alert('Settings saved successfully!');
    } else {
      throw new Error('Failed to save settings');
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
    alert('Failed to save settings. Please try again.');
  }
}

async function saveTierConfig(element, event, tierId) {
  // Support both direct call and event delegation
  if (typeof element === 'number' || (typeof element === 'string' && !isNaN(element))) {
    tierId = element;
  }
  const row = document.querySelector(`tr[data-tier-id="${tierId}"]`);
  const updates = {};

  row.querySelectorAll('input').forEach(input => {
    const field = input.dataset.field;
    if (field) {
      if (input.type === 'checkbox') {
        updates[field] = input.checked;
      } else if (input.type === 'number') {
        updates[field] = input.value === '' ? null : parseFloat(input.value);
      } else {
        updates[field] = input.value;
      }
    }
  });

  try {
    const response = await fetch(`/api/expiry-discounts/tiers/${tierId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    if (response.ok) {
      alert('Tier configuration saved!');
      loadStatus();
    } else {
      throw new Error('Failed to save tier config');
    }
  } catch (error) {
    console.error('Failed to save tier config:', error);
    alert('Failed to save tier configuration. Please try again.');
  }
}

async function runEvaluation() {
  if (!confirm('Run tier evaluation?\n\nThis will evaluate all items and assign discount tiers based on expiration dates.')) {
    return;
  }
  const dryRun = false;

  try {
    const response = await fetch('/api/expiry-discounts/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: dryRun })
    });

    const result = await response.json();

    let message = `Evaluation ${dryRun ? '(Dry Run) ' : ''}Complete!\n\n`;
    message += `Total evaluated: ${result.totalEvaluated}\n`;
    message += `Tier changes: ${result.tierChanges?.length || 0}\n`;
    message += `New assignments: ${result.newAssignments?.length || 0}\n`;
    message += `Unchanged: ${result.unchanged}\n`;
    message += `Errors: ${result.errors?.length || 0}`;

    alert(message);

    if (!dryRun) {
      loadStatus();
      loadItems();
      loadAuditLog();
    }

  } catch (error) {
    console.error('Evaluation failed:', error);
    alert('Evaluation failed. Please check the logs.');
  }
}

// Wrapper for dry run
function runFullAutomationDryRun() {
  runFullAutomationInternal(true);
}

function runFullAutomation() {
  runFullAutomationInternal(false);
}

async function runFullAutomationInternal(dryRun) {
  if (!confirm(`Run full automation${dryRun ? ' (dry run)' : ''}?\n\nThis will:\n1. Initialize Square discount objects\n2. Evaluate all items\n3. Apply discounts to Square`)) {
    return;
  }

  try {
    const response = await fetch('/api/expiry-discounts/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: dryRun })
    });

    const result = await response.json();

    let message = `Automation ${dryRun ? '(Dry Run) ' : ''}Complete!\n\n`;
    message += `Duration: ${result.duration}ms\n\n`;
    message += `Evaluation:\n`;
    message += `  - Total evaluated: ${result.evaluation?.totalEvaluated || 0}\n`;
    message += `  - Tier changes: ${result.evaluation?.tierChanges?.length || 0}\n`;
    message += `  - New assignments: ${result.evaluation?.newAssignments?.length || 0}\n\n`;
    message += `Discounts:\n`;
    message += `  - Applied: ${result.discountApplication?.applied?.length || 0}\n`;
    message += `  - Removed: ${result.discountApplication?.removed?.length || 0}\n\n`;
    message += `Errors: ${result.errors?.length || 0}`;

    alert(message);

    if (!dryRun) {
      loadStatus();
      loadItems();
      loadAuditLog();
    }

  } catch (error) {
    console.error('Automation failed:', error);
    alert('Automation failed. Please check the logs.');
  }
}

async function initSquareDiscounts() {
  if (!confirm('Initialize Square discount objects?\n\nThis will create or update discount catalog objects in Square for the clearance sale and special savings tiers.')) {
    return;
  }

  try {
    const response = await fetch('/api/expiry-discounts/init-square', {
      method: 'POST'
    });

    const result = await response.json();

    let message = 'Square Discount Initialization Complete!\n\n';
    message += `Created: ${result.created?.length || 0}\n`;
    message += `Updated: ${result.updated?.length || 0}\n`;
    message += `Errors: ${result.errors?.length || 0}`;

    alert(message);

  } catch (error) {
    console.error('Square init failed:', error);
    alert('Square discount initialization failed. Please check the logs.');
  }
}

// Wrapper for validate & fix
function validateDiscountsFix() {
  validateDiscountsInternal(true);
}

function validateDiscounts() {
  validateDiscountsInternal(false);
}

async function validateDiscountsInternal(fix) {
  fix = fix || false;
  const validateBtn = document.getElementById('validate-discounts-btn');
  const fixBtn = document.getElementById('validate-fix-discounts-btn');
  const resultsDiv = document.getElementById('validation-results');

  validateBtn.disabled = true;
  fixBtn.disabled = true;
  resultsDiv.style.display = 'block';
  resultsDiv.innerHTML = '<div class="loading">Validating discounts against Square...</div>';

  try {
    const endpoint = fix ? '/api/expiry-discounts/validate-and-fix' : '/api/expiry-discounts/validate';
    const response = await fetch(endpoint, { method: fix ? 'POST' : 'GET' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Validation failed');
    }

    let html = '';

    // Summary stats
    html += `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin-bottom: 15px; text-align: center;">
        <div style="padding: 10px; background: #f3f4f6; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: #374151;">${result.tiersChecked}</div>
          <div style="font-size: 11px; color: #6b7280;">Tiers Checked</div>
        </div>
        <div style="padding: 10px; background: ${result.issues.length > 0 ? '#fef2f2' : '#f0fdf4'}; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: ${result.issues.length > 0 ? '#ef4444' : '#10b981'};">${result.issues.length}</div>
          <div style="font-size: 11px; color: #6b7280;">Issues Found</div>
        </div>
        ${fix ? `
        <div style="padding: 10px; background: ${result.fixed.length > 0 ? '#dbeafe' : '#f3f4f6'}; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: #2563eb;">${result.fixed.length}</div>
          <div style="font-size: 11px; color: #6b7280;">Fixed</div>
        </div>
        ` : ''}
      </div>
    `;

    if (result.issues.length > 0) {
      html += `<div style="background: ${fix && result.fixed.length > 0 ? '#f0fdf4' : '#fef3c7'}; border: 1px solid ${fix && result.fixed.length > 0 ? '#bbf7d0' : '#fcd34d'}; border-radius: 8px; padding: 15px; margin-bottom: 10px;">`;

      if (fix && result.fixed.length > 0) {
        html += `<strong style="color: #166534;">Fixed ${result.fixed.length} issue(s)!</strong><br>`;
      }

      if (result.issues.length > result.fixed.length) {
        html += `<strong style="color: #92400e;">${result.issues.length - result.fixed.length} issue(s) ${fix ? 'could not be fixed' : 'found'}:</strong><br>`;
      }

      html += '<ul style="margin: 10px 0 0 20px; padding: 0;">';
      result.issues.forEach(issue => {
        const wasFixed = fix && result.fixed.some(f => f.tierCode === issue.tierCode && f.action);
        html += `
          <li style="margin-bottom: 8px; ${wasFixed ? 'text-decoration: line-through; color: #6b7280;' : ''}">
            <strong>${escapeHtml(issue.tierCode)}</strong>: ${escapeHtml(issue.issue.replace(/_/g, ' '))}
            ${wasFixed ? '<span style="color: #10b981;"> (Fixed)</span>' : ''}
            <br><small style="color: #6b7280;">${escapeHtml(issue.message)}</small>
          </li>
        `;
      });
      html += '</ul></div>';
    } else {
      html += '<div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 15px;"><strong style="color: #166534;">All discounts validated successfully!</strong><br><span style="color: #15803d;">Square discount objects and pricing rules are correctly configured.</span></div>';
    }

    resultsDiv.innerHTML = html;

  } catch (error) {
    console.error('Validation failed:', error);
    resultsDiv.innerHTML = `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 15px; color: #991b1b;">Failed to validate discounts: ${escapeHtml(error.message)}</div>`;
  } finally {
    validateBtn.disabled = false;
    fixBtn.disabled = false;
  }
}

function getDaysClass(days) {
  if (days === null) return '';
  if (days <= 0) return 'critical';
  if (days <= 30) return 'critical';
  if (days <= 89) return 'warning';
  if (days <= 120) return 'review';
  return 'ok';
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadItems();
  loadAuditLog();
  loadSettings();
  loadTierConfig();
});

// Expose functions to global scope for event delegation
window.switchTab = switchTab;
window.filterByTier = filterByTier;
window.runEvaluation = runEvaluation;
window.runFullAutomation = runFullAutomation;
window.runFullAutomationDryRun = runFullAutomationDryRun;
window.initSquareDiscounts = initSquareDiscounts;
window.saveTierConfig = saveTierConfig;
window.saveSettings = saveSettings;
window.validateDiscounts = validateDiscounts;
window.validateDiscountsFix = validateDiscountsFix;
