/**
 * Expiry Tracker Page Script
 * Handles tracking and updating product expiration dates
 */

// State variables
let allItems = [];
let currentPage = 1;
let itemsPerPage = 50;
let pendingChanges = new Map();

/**
 * Escape strings for use in JavaScript onclick handlers (single-quoted)
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeJsString(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Escape HTML entities to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape for HTML attributes
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtmlAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Handle image fallback (replaces onerror handlers)
document.addEventListener('error', function(e) {
  if (e.target.tagName === 'IMG' && e.target.dataset.fallback === 'image') {
    e.target.style.display = 'none';
  }
}, true);

/**
 * Load items from API with optional filters
 */
async function loadItems() {
  const expiryFilter = document.getElementById('expiry-filter').value;
  const categoryFilter = document.getElementById('category-filter').value;
  const isReviewMode = expiryFilter === 'review';

  // Toggle review mode UI
  const container = document.querySelector('.container');
  const markAllBtn = document.getElementById('mark-all-reviewed-btn');
  if (isReviewMode) {
    container.classList.add('review-mode');
    markAllBtn.style.display = 'inline-block';
  } else {
    container.classList.remove('review-mode');
    markAllBtn.style.display = 'none';
  }

  const tbody = document.getElementById('items-body');
  const colSpan = isReviewMode ? 11 : 10;
  tbody.innerHTML = `<tr><td colspan="${colSpan}" class="loading">Loading...</td></tr>`;

  try {
    let url = '/api/expirations?';
    if (expiryFilter) url += `expiry=${expiryFilter}&`;
    if (categoryFilter) url += `category=${categoryFilter}&`;

    const data = await fetch(url).then(r => r.json());

    // Defensive coding: ensure allItems is always an array
    allItems = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);

    // Hide items with <1 inventory - they can't expire if not in stock
    allItems = allItems.filter(item => (item.quantity || 0) >= 1);

    if (allItems.length === 0) {
      const msg = isReviewMode
        ? 'No items need review. All items in the 91-120 day window have been reviewed.'
        : 'No items found. Please run sync first or adjust filters.';
      tbody.innerHTML = `<tr><td colspan="${colSpan}" class="loading">${msg}</td></tr>`;
      updateStats();
      return;
    }

    currentPage = 1;
    updateStats();
    renderTable();
    updatePagination();

  } catch (error) {
    console.error('Failed to load items:', error);
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="loading">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

/**
 * Update statistics bar
 */
function updateStats() {
  // Defensive coding: ensure allItems is always an array
  if (!Array.isArray(allItems)) {
    allItems = [];
  }

  const total = allItems.length;

  // With Expiration Data: items that have either expiration_date or does_not_expire set
  const withData = allItems.filter(i => i.expiration_date || i.does_not_expire).length;
  const withDataPercent = total > 0 ? ((withData / total) * 100).toFixed(1) : 0;

  // Never Expires: items where does_not_expire is true
  const neverExpires = allItems.filter(i => i.does_not_expire).length;

  // Has Expiry Date: items with an actual expiration_date
  const hasExpiry = allItems.filter(i => i.expiration_date && !i.does_not_expire).length;

  const today = new Date();
  const in120Days = new Date(today.getTime() + 120*24*60*60*1000);
  const expiring = allItems.filter(i => {
    if (!i.expiration_date || i.does_not_expire) return false;
    const expDate = new Date(i.expiration_date);
    return expDate <= in120Days && expDate >= today;
  }).length;

  const totalValue = allItems.reduce((sum, i) => {
    const qty = i.quantity || 0;
    const price = i.price_money || 0;
    return sum + (qty * price / 100);
  }, 0);

  document.getElementById('stat-total').textContent = total.toLocaleString();
  document.getElementById('stat-with-data').textContent = `${withData.toLocaleString()} (${withDataPercent}%)`;
  document.getElementById('stat-never-expires').textContent = neverExpires.toLocaleString();
  document.getElementById('stat-has-expiry').textContent = hasExpiry.toLocaleString();
  document.getElementById('stat-expiring').textContent = expiring.toLocaleString();
  document.getElementById('stat-value').textContent = '$' + totalValue.toLocaleString('en-CA', {minimumFractionDigits: 0, maximumFractionDigits: 0});
}

/**
 * Render the items table
 */
function renderTable() {
  // Defensive coding: ensure allItems is always an array
  if (!Array.isArray(allItems)) {
    allItems = [];
  }

  const tbody = document.getElementById('items-body');
  const start = (currentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = allItems.slice(start, end);
  const isReviewMode = document.getElementById('expiry-filter').value === 'review';
  const colSpan = isReviewMode ? 11 : 10;

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="loading">No products found</td></tr>`;
    return;
  }

  tbody.innerHTML = pageItems.map(item => {
    const expiryValue = item.expiration_date ? item.expiration_date.split('T')[0] : '';
    const imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    const safeId = escapeHtmlAttr(item.identifier);

    return `<tr data-id="${safeId}">
      <td>
        ${imageUrl ?
          `<img src="${imageUrl}" class="product-image" data-fallback="image">` :
          '<div style="width:50px;height:50px;background:#f3f4f6;border-radius:4px;"></div>'}
      </td>
      <td class="product-name">${escapeHtml(item.name || '')}</td>
      <td><small>${escapeHtml(item.category_name || '-')}</small></td>
      <td class="variation-name variation-col">${escapeHtml(item.variation || 'Regular')}</td>
      <td class="gtin gtin-col">${escapeHtml(item.gtin || 'N/A')}</td>
      <td class="price">$${((item.price_money || 0) / 100).toFixed(2)}</td>
      <td>${item.quantity || 0}</td>
      <td>${formatDate(item.expiration_date)}</td>
      <td>
        <div class="date-input-container">
          <input type="date" value="${expiryValue}"
                 data-change="showDateConfirmation" data-item-id="${safeId}"
                 ${item.does_not_expire ? 'disabled' : ''}>
          <div id="confirm-${safeId}" class="date-confirmation">
            <button data-action="confirmDateChange" data-action-param="${safeId}" class="confirm-btn">✓</button>
            <button data-action="cancelDateChange" data-action-param="${safeId}" class="cancel-btn">✕</button>
          </div>
        </div>
      </td>
      <td>
        <input type="checkbox" ${item.does_not_expire ? 'checked' : ''}
               data-change="updateNeverExpires" data-item-id="${safeId}">
      </td>
      <td class="review-col">
        <button class="review-btn" data-action="markAsReviewed" data-action-param="${safeId}">Mark Reviewed</button>
      </td>
    </tr>`;
  }).join('');
}

/**
 * Format date for display
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date (YYYY-MM-DD)
 */
function formatDate(dateStr) {
  if (!dateStr) return 'Not set';
  // Return ISO format (YYYY-MM-DD) - Canadian standard
  return dateStr.split('T')[0];
}

/**
 * Show date confirmation popup
 * Called by event delegation with (param, element, event)
 * @param {any} param - Unused parameter
 * @param {HTMLElement} element - The input element
 * @param {Event} event - The change event
 */
function showDateConfirmation(param, element, event) {
  const input = element;
  const id = input.dataset.itemId;
  const newValue = input.value;
  if (!input.dataset.originalValue) {
    input.dataset.originalValue = input.defaultValue;
  }
  pendingChanges.set(id, { newValue, oldValue: input.dataset.originalValue, inputElement: input });
  document.getElementById(`confirm-${id}`).style.display = 'block';
}

/**
 * Confirm date change and save
 * @param {HTMLElement} element - The button element
 * @param {Event} event - The click event
 * @param {string} id - The item ID from data-action-param
 */
function confirmDateChange(element, event, id) {
  const pending = pendingChanges.get(id);
  if (pending) {
    updateExpiration(id, pending.newValue);
    pending.inputElement.dataset.originalValue = pending.newValue;
    pendingChanges.delete(id);
    document.getElementById(`confirm-${id}`).style.display = 'none';
  }
}

/**
 * Cancel date change
 * @param {HTMLElement} element - The button element
 * @param {Event} event - The click event
 * @param {string} id - The item ID from data-action-param
 */
function cancelDateChange(element, event, id) {
  const pending = pendingChanges.get(id);
  if (pending) {
    pending.inputElement.value = pending.oldValue;
    pendingChanges.delete(id);
    document.getElementById(`confirm-${id}`).style.display = 'none';
  }
}

/**
 * Update expiration date via API
 * @param {string} id - The variation ID
 * @param {string} value - The new expiration date
 */
async function updateExpiration(id, value) {
  try {
    await fetch('/api/expirations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        variation_id: id,
        expiration_date: value || null,
        does_not_expire: false
      }])
    });

    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.add('row-changed');

  } catch (error) {
    alert('Failed to save: ' + error.message);
  }
}

/**
 * Update never expires flag
 * Called by event delegation with (param, element, event)
 * @param {any} param - Unused parameter
 * @param {HTMLElement} element - The checkbox element
 * @param {Event} event - The change event
 */
async function updateNeverExpires(param, element, event) {
  const id = element.dataset.itemId;
  const checked = element.checked;
  const row = document.querySelector(`tr[data-id="${id}"]`);
  const dateInput = row.querySelector('input[type="date"]');
  dateInput.disabled = checked;
  if (checked) dateInput.value = '';

  try {
    await fetch('/api/expirations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        variation_id: id,
        expiration_date: null,
        does_not_expire: checked
      }])
    });

    row.classList.add('row-changed');

  } catch (error) {
    alert('Failed to save: ' + error.message);
  }
}

/**
 * Change page
 * @param {HTMLElement} element - The button element
 * @param {Event} event - The click event
 * @param {string} directionParam - Direction from data-action-param
 */
function changePage(element, event, directionParam) {
  const direction = parseInt(directionParam, 10);
  const totalPages = Math.ceil(allItems.length / itemsPerPage);
  currentPage = Math.max(1, Math.min(totalPages, currentPage + direction));
  renderTable();
  updatePagination();
}

/**
 * Change items per page
 */
function changeItemsPerPage() {
  itemsPerPage = parseInt(document.getElementById('items-per-page').value);
  currentPage = 1;
  renderTable();
  updatePagination();
}

/**
 * Update pagination controls
 */
function updatePagination() {
  const totalPages = Math.ceil(allItems.length / itemsPerPage);
  document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages}`;
  document.getElementById('prev-page').disabled = currentPage <= 1;
  document.getElementById('next-page').disabled = currentPage >= totalPages;
}

/**
 * Sync data from Square
 */
async function syncFromSquare() {
  const btn = document.querySelector('.sync-button');
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  try {
    await fetch('/api/sync-smart', { method: 'POST' });
    alert('Sync complete!');
    await loadItems();
  } catch (error) {
    alert('Sync failed: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync from Square';
  }
}

/**
 * Load categories for filter dropdown
 */
async function loadCategories() {
  try {
    const categories = await fetch('/api/categories').then(r => r.json());
    const select = document.getElementById('category-filter');
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      option.textContent = cat;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load categories:', error);
  }
}

/**
 * Mark a single item as reviewed
 * @param {HTMLElement} element - The button element
 * @param {Event} event - The click event
 * @param {string} variationId - The variation ID from data-action-param
 */
async function markAsReviewed(element, event, variationId) {
  const button = element;
  button.disabled = true;
  button.textContent = 'Saving...';

  try {
    const response = await fetch('/api/expirations/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variation_ids: [variationId],
        reviewed_by: 'User'
      })
    });

    if (!response.ok) throw new Error('Failed to mark as reviewed');

    // Remove the row from the table since it's been reviewed
    const row = document.querySelector(`tr[data-id="${variationId}"]`);
    if (row) {
      row.style.transition = 'opacity 0.3s';
      row.style.opacity = '0';
      setTimeout(() => {
        row.remove();
        // Update allItems array
        allItems = allItems.filter(item => item.identifier !== variationId);
        updateStats();
        updatePagination();
      }, 300);
    }

  } catch (error) {
    alert('Failed to mark as reviewed: ' + error.message);
    button.disabled = false;
    button.textContent = 'Mark Reviewed';
  }
}

/**
 * Mark all items as reviewed
 */
async function markAllAsReviewed() {
  const btn = document.getElementById('mark-all-reviewed-btn');
  if (!confirm(`Mark all ${allItems.length} items as reviewed?`)) return;

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const variationIds = allItems.map(item => item.identifier);

    const response = await fetch('/api/expirations/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variation_ids: variationIds,
        reviewed_by: 'User'
      })
    });

    if (!response.ok) throw new Error('Failed to mark as reviewed');

    const result = await response.json();
    alert(`Marked ${result.reviewed_count} items as reviewed`);

    // Reload to show empty list
    await loadItems();

  } catch (error) {
    alert('Failed to mark all as reviewed: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Mark All as Reviewed';
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  // Check for URL parameters to pre-set filters
  const urlParams = new URLSearchParams(window.location.search);
  const filterParam = urlParams.get('filter');
  if (filterParam) {
    const filterSelect = document.getElementById('expiry-filter');
    // Map friendly names to filter values
    const filterMap = {
      'expiring': '120',
      'expiring-soon': '120',
      'no-data': 'no-expiry',
      'missing': 'no-expiry',
      'review': 'review',
      '30': '30',
      '60': '60',
      '90': '90',
      '120': '120'
    };
    const filterValue = filterMap[filterParam] || filterParam;
    if (filterSelect.querySelector(`option[value="${filterValue}"]`)) {
      filterSelect.value = filterValue;
    }
  }
  loadCategories();
  loadItems();
});

// Expose functions to global scope for event delegation
window.loadItems = loadItems;
window.markAllAsReviewed = markAllAsReviewed;
window.syncFromSquare = syncFromSquare;
window.changePage = changePage;
window.confirmDateChange = confirmDateChange;
window.cancelDateChange = cancelDateChange;
window.markAsReviewed = markAsReviewed;
window.showDateConfirmation = showDateConfirmation;
window.updateNeverExpires = updateNeverExpires;
window.changeItemsPerPage = changeItemsPerPage;
