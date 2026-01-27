/**
 * Inventory page JavaScript
 * Externalized from inventory.html for CSP compliance (P0-4 Phase 2)
 */

let allData = [];
let filteredData = [];
let locations = new Set();
let categories = new Set();
let vendors = new Set();
let currentSortField = null;
let sortDirections = {}; // Track direction for each field

// Setup event delegation for dynamic elements
document.addEventListener('DOMContentLoaded', function() {
  // Handle image errors via delegation
  document.addEventListener('error', function(event) {
    if (event.target.classList && event.target.classList.contains('product-image')) {
      event.target.style.display = 'none';
      const nextSibling = event.target.nextElementSibling;
      if (nextSibling && nextSibling.classList.contains('no-image')) {
        nextSibling.style.display = 'flex';
      }
    }
  }, true);

  // Handle clicks on editable display elements
  document.addEventListener('click', function(event) {
    const editableDisplay = event.target.closest('.editable-display');
    if (editableDisplay) {
      const variationId = editableDisplay.dataset.variationId;
      const field = editableDisplay.dataset.field;
      const currentValue = editableDisplay.dataset.currentValue === 'null' ? null : parseInt(editableDisplay.dataset.currentValue);
      enterEditMode(editableDisplay, variationId, field, currentValue);
    }
  });

  // Handle blur/keydown on case pack inputs via delegation
  document.addEventListener('blur', function(event) {
    if (event.target.classList && event.target.classList.contains('case-pack-input')) {
      saveField(event.target);
    }
  }, true);

  document.addEventListener('keydown', function(event) {
    if (event.target.classList && event.target.classList.contains('case-pack-input')) {
      if (event.key === 'Enter') {
        event.target.blur();
      }
    }
  });

  // Load data on page load
  loadData();
});

function showLoading() {
  document.querySelector('.loading').style.display = 'block';
  document.querySelector('.error').style.display = 'none';
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('stats').style.display = 'none';
}

function showError(message) {
  document.querySelector('.loading').style.display = 'none';
  document.querySelector('.error').style.display = 'block';
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('stats').style.display = 'none';
}

function showData() {
  document.querySelector('.loading').style.display = 'none';
  document.querySelector('.error').style.display = 'none';
  document.getElementById('dataTable').style.display = 'table';
  document.getElementById('stats').style.display = 'grid';
}

function getStockBadge(item) {
  const qty = parseFloat(item.quantity || 0);
  const min = parseFloat(item.stock_alert_min || 0);

  if (qty === 0) {
    return '<span class="stock-badge stock-out">OUT</span>';
  } else if (min > 0 && qty <= min) {
    return '<span class="stock-badge stock-low">LOW</span>';
  } else {
    return '<span class="stock-badge stock-good">OK</span>';
  }
}

function calculateStats(data) {
  const totalRecords = data.length;
  const uniqueProducts = new Set(data.map(item => item.variation_id)).size;
  const totalUnits = data.reduce((sum, item) => sum + parseFloat(item.quantity || 0), 0);
  const totalValue = data.reduce((sum, item) => {
    const qty = parseFloat(item.quantity || 0);
    const cost = parseFloat(item.unit_cost_cents || 0);
    return sum + (qty * cost / 100);
  }, 0);
  const outOfStock = data.filter(item => parseFloat(item.quantity || 0) === 0).length;

  document.getElementById('totalRecords').textContent = totalRecords.toLocaleString();
  document.getElementById('uniqueProducts').textContent = uniqueProducts.toLocaleString();
  document.getElementById('totalUnits').textContent = Math.floor(totalUnits).toLocaleString();
  document.getElementById('totalValue').textContent = '$' + totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  document.getElementById('outOfStock').textContent = outOfStock.toLocaleString();
}

function filterData() {
  const searchTerm = document.getElementById('searchBox').value.toLowerCase();
  const locationFilter = document.getElementById('locationFilter').value;
  const categoryFilter = document.getElementById('categoryFilter').value;
  const vendorFilter = document.getElementById('vendorFilter').value;
  const stockFilter = document.getElementById('stockFilter').value;

  filteredData = allData.filter(item => {
    const matchesSearch = !searchTerm ||
      (item.item_name && item.item_name.toLowerCase().includes(searchTerm)) ||
      (item.variation_name && item.variation_name.toLowerCase().includes(searchTerm)) ||
      (item.sku && item.sku.toLowerCase().includes(searchTerm));

    const matchesLocation = !locationFilter || item.location_name === locationFilter;
    const matchesCategory = !categoryFilter || item.category_name === categoryFilter;
    const matchesVendor = !vendorFilter || item.vendor_name === vendorFilter;

    const qty = parseFloat(item.quantity || 0);
    const min = parseFloat(item.stock_alert_min || 0);
    const matchesStock = !stockFilter ||
      (stockFilter === 'in_stock' && qty > 0) ||
      (stockFilter === 'low_stock' && min > 0 && qty <= min) ||
      (stockFilter === 'out_of_stock' && qty === 0) ||
      (stockFilter === 'negative_stock' && qty < 0);

    return matchesSearch && matchesLocation && matchesCategory && matchesVendor && matchesStock;
  });

  renderTable(filteredData);
  calculateStats(filteredData);
  document.getElementById('statusBadge').textContent =
    `Showing ${filteredData.length} of ${allData.length} records`;
}

async function loadData() {
  showLoading();

  try {
    const response = await fetch('/api/inventory');
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const result = await response.json();
    allData = result.inventory || [];

    if (allData.length === 0) {
      showError('No inventory data available');
      return;
    }

    // Calculate total value for sorting
    allData = allData.map(item => ({
      ...item,
      total_value: (parseFloat(item.quantity || 0) * parseFloat(item.unit_cost_cents || 0)) / 100
    }));

    // Populate location filter
    locations = new Set(allData.map(item => item.location_name).filter(Boolean));
    const locationSelect = document.getElementById('locationFilter');
    locationSelect.innerHTML = '<option value="">All Locations</option>';
    Array.from(locations).sort().forEach(location => {
      const option = document.createElement('option');
      option.value = location;
      option.textContent = location;
      locationSelect.appendChild(option);
    });

    // Populate category filter
    categories = new Set(allData.map(item => item.category_name).filter(Boolean));
    const categorySelect = document.getElementById('categoryFilter');
    categorySelect.innerHTML = '<option value="">All Categories</option>';
    Array.from(categories).sort().forEach(category => {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      categorySelect.appendChild(option);
    });

    // Populate vendor filter
    vendors = new Set(allData.map(item => item.vendor_name).filter(Boolean));
    const vendorSelect = document.getElementById('vendorFilter');
    vendorSelect.innerHTML = '<option value="">All Vendors</option>';
    Array.from(vendors).sort().forEach(vendor => {
      const option = document.createElement('option');
      option.value = vendor;
      option.textContent = vendor;
      vendorSelect.appendChild(option);
    });

    filteredData = allData;
    renderTable(filteredData);
    calculateStats(filteredData);
    showData();

    document.getElementById('statusBadge').textContent =
      `${allData.length} records • Updated: ${new Date().toLocaleTimeString()}`;

  } catch (error) {
    console.error('Error loading data:', error);
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error, 'inventory', 'load')
      : 'Unable to load inventory. Please refresh the page.';
    showError(friendlyMsg);
  }
}

function sortTable(element, event, field, forceDirection = null) {
  // Support both direct call and event delegation
  if (typeof element === 'string') {
    field = element;
    forceDirection = event; // event is actually forceDirection in direct call
  }
  // Toggle sort direction or use forced direction
  if (forceDirection !== null) {
    sortDirections[field] = forceDirection;
  } else {
    sortDirections[field] = !sortDirections[field];
  }
  const ascending = sortDirections[field];

  // Update current sort field
  currentSortField = field;

  // Clear all sort indicators
  document.querySelectorAll('.sort-indicator').forEach(el => {
    el.className = 'sort-indicator';
  });

  // Set current indicator
  const indicator = document.getElementById(`sort-${field}`);
  if (indicator) {
    indicator.className = `sort-indicator ${ascending ? 'asc' : 'desc'}`;
  }

  // Sort the data
  filteredData.sort((a, b) => {
    let aVal = a[field];
    let bVal = b[field];

    // Handle special cases
    switch(field) {
      case 'item_name':
      case 'variation_name':
      case 'sku':
      case 'location_name':
      case 'vendor_name':
      case 'vendor_code':
      case 'category_name':
        // String comparison (case-insensitive)
        aVal = (aVal || '').toString().toLowerCase();
        bVal = (bVal || '').toString().toLowerCase();
        break;

      case 'quantity':
      case 'stock_alert_min':
      case 'stock_alert_max':
      case 'case_pack_quantity':
      case 'unit_cost_cents':
      case 'total_value':
      case 'weekly_avg_91d':
      case 'weekly_avg_182d':
      case 'weekly_avg_365d':
      case 'days_until_stockout':
        // Numeric comparison (handle null/undefined)
        aVal = parseFloat(aVal) || 0;
        bVal = parseFloat(bVal) || 0;
        break;
    }

    // Compare values
    if (aVal === bVal) return 0;

    if (ascending) {
      return aVal > bVal ? 1 : -1;
    } else {
      return aVal < bVal ? 1 : -1;
    }
  });

  // Re-render table with sorted data
  renderTable(filteredData);
}

function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  data.forEach(item => {
    const row = document.createElement('tr');
    const qty = parseFloat(item.quantity || 0);
    const unitCost = parseFloat(item.unit_cost_cents || 0) / 100;
    const totalValue = qty * unitCost;

    // Get image URL
    const imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    const imageHtml = imageUrl
      ? `<img src="${imageUrl}" class="product-image" alt="Product">
         <div class="no-image" style="display:none;">📦</div>`
      : `<div class="no-image">📦</div>`;

    // Get velocity class and formatting
    const dailyVelocity = (item.weekly_avg_91d || 0) / 7;
    const getVelocityClass = (velocity) => {
      if (velocity >= 1) return 'velocity-fast';
      if (velocity >= 0.3) return 'velocity-moderate';
      if (velocity > 0) return 'velocity-slow';
      return 'velocity-none';
    };
    const velocityClass = getVelocityClass(dailyVelocity);
    const formatVelocity = (weekly) => {
      const weeklyNum = parseFloat(weekly) || 0;
      if (weeklyNum === 0) return '<span class="velocity-none">None</span>';
      return `<span class="${getVelocityClass(weeklyNum / 7)}">${weeklyNum.toFixed(1)}</span>`;
    };
    const velocityHtml = `
      ${formatVelocity(item.weekly_avg_91d)} /
      ${formatVelocity(item.weekly_avg_182d)} /
      ${formatVelocity(item.weekly_avg_365d)}
    `;

    // Get days until stockout formatting
    const daysLeft = parseFloat(item.days_until_stockout) || 0;
    const getDaysClass = (days) => {
      if (days <= 0) return 'days-urgent';
      if (days <= 7) return 'days-urgent';
      if (days <= 30) return 'days-warning';
      return 'days-ok';
    };
    const daysHtml = daysLeft === 999
      ? '<span class="days-ok">∞</span>'
      : `<span class="${getDaysClass(daysLeft)}">${daysLeft.toFixed(0)}</span>`;

    row.innerHTML = `
      <td>${imageHtml}</td>
      <td>
        <div class="product-name">${escapeHtml(item.item_name || 'Unknown Product')}</div>
        ${item.variation_name ? `<div class="variation-name">${escapeHtml(item.variation_name)}</div>` : ''}
      </td>
      <td><span class="sku">${escapeHtml(item.sku || '-')}</span></td>
      <td>${escapeHtml(item.location_name || '-')}</td>
      <td class="text-right"><strong>${qty.toFixed(1)}</strong></td>
      <td class="text-right"><small>${velocityHtml}</small></td>
      <td class="text-right">${daysHtml}</td>
      <td class="text-right">${item.stock_alert_min || '-'}</td>
      <td class="text-right editable-cell">
        <div class="editable-display ${item.stock_alert_max ? 'has-value' : ''}"
             data-variation-id="${escapeHtml(item.variation_id)}"
             data-field="stock_alert_max"
             data-current-value="${item.stock_alert_max || 'null'}">
          ${item.stock_alert_max ? item.stock_alert_max : '<span class="infinity-symbol">∞</span>'}
        </div>
      </td>
      <td class="text-right editable-cell">
        <input type="number"
               class="editable-input case-pack-input"
               value="${item.case_pack_quantity || ''}"
               placeholder="-"
               min="1"
               data-field="case_pack_quantity"
               data-variation-id="${escapeHtml(item.variation_id)}">
      </td>
      <td class="text-right">$${unitCost.toFixed(2)}</td>
      <td class="text-right"><strong>$${totalValue.toFixed(2)}</strong></td>
      <td>${escapeHtml(item.vendor_name || '-')}</td>
      <td>${escapeHtml(item.vendor_code || '-')}</td>
      <td>${escapeHtml(item.category_name || '-')}</td>
      <td>${getStockBadge(item)}</td>
    `;
    tbody.appendChild(row);
  });
}

// Save editable field to database
async function saveField(input) {
  const variationId = input.dataset.variationId;
  const field = input.dataset.field;
  const value = input.value.trim();

  // Don't save if value is empty or unchanged
  const item = allData.find(s => s.variation_id === variationId);
  if (!item) return;

  const currentValue = item[field];
  const newValue = value === '' ? null : parseInt(value, 10);

  // Check if value actually changed
  if (currentValue === newValue || (currentValue == null && newValue == null)) {
    return;
  }

  // Validate
  if (value !== '' && (isNaN(newValue) || newValue < 0)) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);
    input.value = currentValue || '';
    return;
  }

  // Show saving state
  input.classList.add('saving');
  input.disabled = true;

  try {
    const response = await fetch(`/api/variations/${variationId}/extended`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        [field]: newValue
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Update local data
    item[field] = newValue;

    // Show success state
    input.classList.remove('saving');
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 2000);

  } catch (error) {
    console.error('Failed to save field:', error);
    input.classList.remove('saving');
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);

    // Revert to original value
    input.value = currentValue || '';
    alert(`Failed to save ${field}: ${error.message}`);
  } finally {
    input.disabled = false;
  }
}

// Enter edit mode for stock maximum field
function enterEditMode(displayElement, variationId, field, currentValue) {
  // Create input element
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'editable-input';
  input.value = currentValue === null ? '' : currentValue;
  input.placeholder = '∞';
  input.min = '0';
  input.dataset.variationId = variationId;
  input.dataset.field = field;

  // Save on blur or Enter key
  input.onblur = function() {
    exitEditMode(this, true);
  };
  input.onkeydown = function(e) {
    if (e.key === 'Enter') {
      this.blur();
    } else if (e.key === 'Escape') {
      exitEditMode(this, false);
    }
  };

  // Replace display with input
  const cell = displayElement.parentElement;
  cell.innerHTML = '';
  cell.appendChild(input);
  input.focus();
  input.select();
}

// Exit edit mode and optionally save
async function exitEditMode(input, save) {
  const variationId = input.dataset.variationId;
  const field = input.dataset.field;
  const value = input.value.trim();

  const item = allData.find(s => s.variation_id === variationId);
  if (!item) return;

  const currentValue = item[field];
  const newValue = value === '' ? null : parseInt(value, 10);

  // If saving and value changed, save it
  if (save && currentValue !== newValue) {
    // Validate
    if (value !== '' && (isNaN(newValue) || newValue < 0)) {
      alert('Please enter a valid positive number or leave empty for unlimited.');
      recreateDisplay(input.parentElement, variationId, field, currentValue);
      return;
    }

    // Show saving state
    input.classList.add('saving');
    input.disabled = true;

    try {
      const response = await fetch(`/api/variations/${variationId}/extended`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          [field]: newValue
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Update local data
      item[field] = newValue;

      // Recreate display with new value
      recreateDisplay(input.parentElement, variationId, field, newValue);

    } catch (error) {
      console.error('Failed to save field:', error);
      const friendlyMsg = window.ErrorHelper
        ? ErrorHelper.getFriendlyMessage(error, 'inventory', 'update')
        : 'Failed to save changes. Please try again.';
      alert(friendlyMsg);
      recreateDisplay(input.parentElement, variationId, field, currentValue);
    }
  } else {
    // Not saving or no change, just recreate display
    recreateDisplay(input.parentElement, variationId, field, currentValue);
  }
}

// Recreate the display element
function recreateDisplay(cell, variationId, field, value) {
  const displayDiv = document.createElement('div');
  displayDiv.className = `editable-display ${value ? 'has-value' : ''}`;
  displayDiv.dataset.variationId = variationId;
  displayDiv.dataset.field = field;
  displayDiv.dataset.currentValue = value === null ? 'null' : value;

  if (value) {
    displayDiv.textContent = value;
  } else {
    displayDiv.innerHTML = '<span class="infinity-symbol">∞</span>';
  }

  cell.innerHTML = '';
  cell.appendChild(displayDiv);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Expose functions to global scope for event delegation
window.loadData = loadData;
window.sortTable = sortTable;
window.filterData = filterData;
