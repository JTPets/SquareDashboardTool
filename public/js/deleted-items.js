/**
 * Deleted & Archived Items page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

let allItems = [];
let filteredItems = [];
let deletedCount = 0;
let archivedCount = 0;

async function loadDeletedItems() {
  const statusFilter = document.getElementById('status-filter').value;
  const ageFilter = document.getElementById('age-filter').value;
  const tbody = document.getElementById('items-body');
  tbody.innerHTML = '<tr><td colspan="9" class="loading">Loading items...</td></tr>';

  try {
    const params = new URLSearchParams();
    if (statusFilter) params.append('status', statusFilter);
    if (ageFilter) params.append('age_months', ageFilter);

    const url = '/api/deleted-items' + (params.toString() ? '?' + params.toString() : '');

    const response = await fetch(url);
    const data = await response.json();

    allItems = data.deleted_items || [];
    deletedCount = data.deleted_count || 0;
    archivedCount = data.archived_count || 0;

    // Populate category filter
    const categories = [...new Set(allItems.map(item => item.category_name).filter(Boolean))].sort();
    const categorySelect = document.getElementById('category-filter');
    const currentValue = categorySelect.value;
    categorySelect.innerHTML = '<option value="">All Categories</option>';
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      option.textContent = cat;
      categorySelect.appendChild(option);
    });
    categorySelect.value = currentValue; // Restore previous selection

    filterItems();

  } catch (error) {
    console.error('Failed to load items:', error);
    tbody.innerHTML = `<tr><td colspan="9" class="loading">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

function filterItems() {
  const categoryFilter = document.getElementById('category-filter').value;

  filteredItems = allItems.filter(item => {
    const matchesCategory = !categoryFilter || item.category_name === categoryFilter;
    return matchesCategory;
  });

  const tbody = document.getElementById('items-body');
  if (filteredItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-state">
          <h3>No Items Found</h3>
          <p>No items match your criteria. Try adjusting the filters.</p>
        </td>
      </tr>
    `;
    updateFooter();
    return;
  }

  renderTable();
  updateFooter();
}

function renderTable() {
  const tbody = document.getElementById('items-body');

  tbody.innerHTML = filteredItems.map((item) => {
    // Get image URL
    const imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    const statusIcon = item.status === 'archived' ? '📦' : '🗑️';
    const imageHtml = imageUrl
      ? `<img src="${imageUrl}" class="product-image fallback-image" alt="Product" data-fallback-icon="${statusIcon}">
         <div class="no-image" style="display:none;">${statusIcon}</div>`
      : `<div class="no-image">${statusIcon}</div>`;

    // Status badge
    const statusClass = item.status === 'archived' ? 'status-archived' : 'status-deleted';
    const statusLabel = item.status === 'archived' ? 'Archived' : 'Deleted';
    const statusBadge = `<span class="status-badge ${statusClass}">${statusLabel}</span>`;

    // Calculate age badge (use days_inactive which handles both deleted and archived)
    const daysInactive = Math.floor(item.days_inactive || 0);
    let ageBadge = '';
    let ageClass = '';
    if (daysInactive < 90) {
      ageBadge = `${daysInactive} days`;
      ageClass = 'age-recent';
    } else if (daysInactive < 365) {
      ageBadge = `${Math.floor(daysInactive / 30)} months`;
      ageClass = 'age-old';
    } else {
      ageBadge = `${Math.floor(daysInactive / 365)} years`;
      ageClass = 'age-ancient';
    }

    // Stock status
    const stockClass = item.current_stock > 0 ? 'stock-warning' : 'stock-ok';
    const stockText = item.current_stock > 0
      ? `${item.current_stock} ⚠️`
      : '0 ✓';

    // Format date (use deleted_at or archived_at)
    const inactiveDate = item.deleted_at || item.archived_at;
    const formattedDate = inactiveDate
      ? new Date(inactiveDate).toLocaleDateString()
      : 'Unknown';

    // Format price
    const price = item.price_money
      ? `${item.currency || 'CAD'} $${(item.price_money / 100).toFixed(2)}`
      : '-';

    return `
      <tr>
        <td>${imageHtml}</td>
        <td>
          <div class="product-name">${escapeHtml(item.item_name)}</div>
          ${item.variation_name ? `<div class="variation-name">${escapeHtml(item.variation_name)}</div>` : ''}
        </td>
        <td class="sku">${escapeHtml(item.sku || '-')}</td>
        <td>${statusBadge}</td>
        <td>${escapeHtml(item.category_name || '-')}</td>
        <td class="text-right ${stockClass}">${stockText}</td>
        <td>${formattedDate}</td>
        <td><span class="age-badge ${ageClass}">${ageBadge}</span></td>
        <td class="text-right">${price}</td>
      </tr>
    `;
  }).join('');
}

function updateFooter() {
  document.getElementById('item-count').textContent = filteredItems.length;
  document.getElementById('deleted-count').textContent = filteredItems.filter(i => i.status === 'deleted').length;
  document.getElementById('archived-count').textContent = filteredItems.filter(i => i.status === 'archived').length;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadDeletedItems();
});

// Handle image load errors (CSP-compliant replacement for onerror attribute)
document.addEventListener('error', function(event) {
  if (event.target.classList && event.target.classList.contains('fallback-image')) {
    event.target.style.display = 'none';
    const fallback = event.target.nextElementSibling;
    if (fallback) {
      fallback.style.display = 'flex';
    }
  }
}, true);

// Expose functions to global scope for event delegation
window.loadDeletedItems = loadDeletedItems;
window.filterItems = filterItems;
