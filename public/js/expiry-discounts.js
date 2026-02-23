/**
 * Expiry Discounts page JavaScript
 * Externalized from expiry-discounts.html for CSP compliance (P0-4 Phase 2)
 */

// State
let currentTierFilter = null;
let statusData = null;
let tierRanges = {};
let tierNames = {};

// Load tier configuration from API for dynamic tier evaluation
async function loadTierRanges() {
  try {
    const response = await fetch('/api/expiry-discounts/tiers');
    const data = await response.json();
    tierRanges = {};
    tierNames = {};
    for (const tier of data.tiers || []) {
      tierRanges[tier.tier_code] = {
        min: tier.min_days_to_expiry,
        max: tier.max_days_to_expiry
      };
      tierNames[tier.tier_code] = tier.tier_name || tier.tier_code;
    }
  } catch (error) {
    console.error('Failed to load tier ranges, using defaults:', error);
    tierRanges = {
      'EXPIRED': { min: null, max: 0 },
      'AUTO50': { min: 1, max: 30 },
      'AUTO25': { min: 31, max: 89 },
      'REVIEW': { min: 90, max: 120 },
      'OK': { min: 121, max: null }
    };
  }
}

// Get tier code from days until expiry using API-loaded config
function getTierFromDays(daysUntilExpiry) {
  if (daysUntilExpiry === null || daysUntilExpiry === undefined) return null;
  for (const [tierCode, range] of Object.entries(tierRanges)) {
    const minOk = range.min === null || daysUntilExpiry >= range.min;
    const maxOk = range.max === null || daysUntilExpiry <= range.max;
    if (minOk && maxOk) return tierCode;
  }
  return null;
}

// Get CSS class for days badge using API-loaded tier config
function getDaysClassFromTier(days) {
  if (days === null) return '';
  const tier = getTierFromDays(days);
  if (!tier) return '';
  if (tier === 'EXPIRED' || tier === 'AUTO50') return 'critical';
  if (tier === 'AUTO25') return 'warning';
  if (tier === 'REVIEW') return 'review';
  return 'ok';
}

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
  } else if (tabName === 'flagged') {
    loadFlagged();
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

    // Update tier counts and labels from API data
    for (const tier of statusData.tiers) {
      const countEl = document.getElementById(`count-${tier.tier_code}`);
      if (countEl) {
        countEl.textContent = tier.variation_count || 0;
      }
      // Update the tier card day range labels dynamically
      const card = document.querySelector(`.tier-card.tier-${tier.tier_code} .discount`);
      if (card && tier.min_days !== undefined) {
        const minDays = tier.min_days ?? '';
        const maxDays = tier.max_days ?? '';
        if (tier.tier_code === 'EXPIRED') {
          card.textContent = 'Remove from shelf';
        } else if (tier.tier_code === 'OK') {
          card.textContent = minDays ? `>${minDays - 1} days` : '>120 days';
        } else if (minDays && maxDays) {
          card.textContent = `${minDays}-${maxDays} days`;
        }
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

    // Build tier boundaries from API-loaded config
    const boundaries = [];
    for (const [tierCode, range] of Object.entries(tierRanges)) {
      if (range.max !== null && tierCode !== 'OK') {
        boundaries.push({ boundary: range.max, tierCode });
      }
      if (range.min !== null && range.min > 0) {
        boundaries.push({ boundary: range.min - 1, tierCode: null }); // approaching from above
      }
    }
    // Deduplicate boundary values
    const boundaryValues = [...new Set(boundaries.map(b => b.boundary))];

    // Filter to items approaching tier boundaries
    const upcoming = data.variations.filter(item => {
      const days = item.days_until_expiry;
      if (days === null) return false;
      return boundaryValues.some(b => days > b && days <= b + 5);
    });

    if (upcoming.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No items approaching tier changes in the next 5 days.</td></tr>';
      return;
    }

    tbody.innerHTML = upcoming.map(item => {
      const days = item.days_until_expiry;
      // Calculate what tier they'll move to using API-loaded config
      const nextTier = getTierFromDays(days - 5) || 'OK';
      const currentTier = getTierFromDays(days) || item.tier_code;

      // Find the closest boundary this item is approaching
      let daysUntilChange = 0;
      for (const bv of boundaryValues.sort((a, b) => a - b)) {
        if (days > bv && days <= bv + 5) {
          daysUntilChange = days - bv;
          break;
        }
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

async function loadFlagged() {
  const tbody = document.getElementById('flagged-table-body');

  try {
    const response = await fetch('/api/expiry-discounts/flagged');
    const data = await response.json();

    // Update badge
    const badge = document.getElementById('flagged-count-badge');
    if (data.flagged.length > 0) {
      badge.textContent = data.flagged.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }

    if (data.flagged.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No items flagged for review. All tier changes are normal.</td></tr>';
      return;
    }

    tbody.innerHTML = data.flagged.map(item => {
      const overrideDate = item.manual_override_at
        ? new Date(item.manual_override_at).toLocaleString()
        : '-';

      return `
        <tr data-flagged-id="${item.variation_id}">
          <td>
            <strong>${escapeHtml(item.item_name)}</strong>
            ${item.variation_name ? `<br><small style="color: #6b7280;">${escapeHtml(item.variation_name)}</small>` : ''}
          </td>
          <td style="font-family: monospace; font-size: 12px;">${escapeHtml(item.sku || '-')}</td>
          <td><span class="tier-badge tier-${item.current_tier_code || 'OK'}">${item.current_tier_code || '-'}</span></td>
          <td><span class="tier-badge tier-${item.calculated_tier_code || 'OK'}">${item.calculated_tier_code || '-'}</span>
              <br><small style="color: #6b7280;">${item.calculated_discount_percent}% off</small></td>
          <td><span class="days-badge ${getDaysClass(item.days_until_expiry)}">${item.days_until_expiry !== null ? item.days_until_expiry + 'd' : '-'}</span></td>
          <td style="font-size: 12px;">${overrideDate}</td>
          <td>
            <input type="text" class="resolve-note-input" placeholder="Note (required)..."
                   id="note-${item.variation_id}">
            <div class="resolve-actions">
              <button class="btn-resolve-apply" data-action="resolveFlagged"
                      data-action-param="${item.variation_id}|apply_new"
                      title="Apply the calculated tier">Apply New</button>
              <button class="btn-resolve-keep" data-action="resolveFlagged"
                      data-action-param="${item.variation_id}|keep_current"
                      title="Keep the current tier">Keep Current</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Failed to load flagged items:', error);
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load flagged items.</td></tr>';
  }
}

async function resolveFlagged(element, event, param) {
  const [variationId, action] = param.split('|');
  const noteInput = document.getElementById(`note-${variationId}`);
  const note = noteInput ? noteInput.value.trim() : '';

  if (!note) {
    alert('Please enter a note explaining your decision.');
    if (noteInput) noteInput.focus();
    return;
  }

  try {
    const response = await fetch('/api/expiry-discounts/flagged/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variation_id: variationId, action, note })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Failed to resolve');
    }

    // Remove the row
    const row = document.querySelector(`tr[data-flagged-id="${variationId}"]`);
    if (row) {
      row.style.transition = 'opacity 0.3s';
      row.style.opacity = '0';
      setTimeout(() => {
        row.remove();
        // Update badge count
        const remaining = document.querySelectorAll('#flagged-table-body tr[data-flagged-id]').length;
        const badge = document.getElementById('flagged-count-badge');
        if (remaining > 0) {
          badge.textContent = remaining;
        } else {
          badge.style.display = 'none';
          document.getElementById('flagged-table-body').innerHTML =
            '<tr><td colspan="7" class="empty-state">No items flagged for review. All tier changes are normal.</td></tr>';
        }
      }, 300);
    }

    // Refresh related data
    loadStatus();
    loadAuditLog();

  } catch (error) {
    console.error('Failed to resolve flagged item:', error);
    alert('Failed to resolve: ' + error.message);
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
  // Delegate to API-loaded tier config when available, fall back to hardcoded
  if (Object.keys(tierRanges).length > 0) {
    return getDaysClassFromTier(days);
  }
  // Fallback if tiers not yet loaded
  if (days === null) return '';
  if (days <= 0) return 'critical';
  if (days <= 30) return 'critical';
  if (days <= 89) return 'warning';
  if (days <= 120) return 'review';
  return 'ok';
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await loadTierRanges();
  loadStatus();
  loadItems();
  loadFlagged(); // Load flagged count for badge
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
window.resolveFlagged = resolveFlagged;
