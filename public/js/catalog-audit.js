/**
 * Catalog Audit page JavaScript
 * Externalized from catalog-audit.html for CSP compliance (P0-4 Phase 2)
 */

let allData = [];
let filteredData = [];
let auditStats = {};
let categories = new Set();
let currentSortField = null;
let sortDirections = {};
let activeAuditCard = null;

const AUDIT_TYPES = [
  // Data Quality Issues
  { key: 'missing_category', label: 'No Category', severity: 'critical' },
  { key: 'not_taxable', label: 'Not Taxable', severity: 'warning' },
  { key: 'missing_price', label: 'No Price', severity: 'critical' },
  { key: 'missing_description', label: 'No Description', severity: 'warning' },
  { key: 'missing_item_image', label: 'No Image', severity: 'warning' },
  { key: 'missing_sku', label: 'No SKU', severity: 'critical' },
  { key: 'missing_upc', label: 'No UPC', severity: 'info' },
  { key: 'stock_tracking_off', label: 'Stock Tracking Off', severity: 'critical' },
  { key: 'inventory_alerts_off', label: 'Inv Alerts Off', severity: 'critical' },
  { key: 'no_reorder_threshold', label: 'OOS, No Min', severity: 'critical' },
  { key: 'missing_vendor', label: 'No Vendor', severity: 'warning' },
  { key: 'missing_cost', label: 'No Cost', severity: 'warning', note: 'Excludes SAMPLE variations' },
  // SEO
  { key: 'missing_seo_title', label: 'No SEO Title', severity: 'info' },
  { key: 'missing_seo_description', label: 'No SEO Desc', severity: 'info' },
  // Tax
  { key: 'no_tax_ids', label: 'No Tax IDs', severity: 'warning' },
  { key: 'location_mismatch', label: 'Location Mismatch', severity: 'critical' },
  // Sales Channels
  { key: 'any_channel_off', label: 'Channel Disabled', severity: 'warning' },
  { key: 'pos_disabled', label: 'POS Disabled', severity: 'info' },
  { key: 'online_disabled', label: 'Online Disabled', severity: 'info' }
];

function showLoading() {
  document.querySelector('.loading').style.display = 'block';
  document.querySelector('.error').style.display = 'none';
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
  document.getElementById('auditSummary').style.display = 'none';
}

function showError(message) {
  document.querySelector('.loading').style.display = 'none';
  document.querySelector('.error').style.display = 'block';
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
  document.getElementById('auditSummary').style.display = 'none';
}

function showData() {
  document.querySelector('.loading').style.display = 'none';
  document.querySelector('.error').style.display = 'none';
  document.getElementById('dataTable').style.display = 'table';
  document.getElementById('statsBar').style.display = 'grid';
  document.getElementById('auditSummary').style.display = 'block';
}

function getSeverityClass(count, total) {
  const percent = (count / total) * 100;
  if (percent > 20) return 'critical';
  if (percent > 5) return 'warning';
  return 'good';
}

function renderAuditCards() {
  const grid = document.getElementById('auditGrid');
  grid.innerHTML = '';

  const total = auditStats.total_items;

  AUDIT_TYPES.forEach(audit => {
    const count = auditStats[audit.key] || 0;
    const percent = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
    const severityClass = count === 0 ? 'good' : getSeverityClass(count, total);

    const card = document.createElement('div');
    card.className = `audit-card ${severityClass}`;
    card.dataset.issueType = audit.key;
    card.onclick = () => selectAuditCard(audit.key, card);

    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">${audit.label}</span>
      </div>
      <div class="card-value">${count.toLocaleString()}</div>
      <div class="card-percent">${percent}% of catalog</div>
      ${audit.note ? `<div class="card-note">${audit.note}</div>` : ''}
    `;

    grid.appendChild(card);
  });
}

function selectAuditCard(issueType, card) {
  // Toggle selection
  if (activeAuditCard === card) {
    card.classList.remove('active');
    activeAuditCard = null;
    document.getElementById('issueFilter').value = '';
    filterData();
  } else {
    // Deselect previous
    if (activeAuditCard) {
      activeAuditCard.classList.remove('active');
    }
    card.classList.add('active');
    activeAuditCard = card;
    document.getElementById('issueFilter').value = issueType;
    filterByIssue();
  }
}

function calculateStats(data) {
  const total = auditStats.total_items;
  const withIssues = auditStats.items_with_issues;
  const completionRate = total > 0 ? (((total - withIssues) / total) * 100).toFixed(1) : 100;

  // Count critical issues (missing category, price, sku, stock tracking, inventory alerts)
  const criticalCount = (auditStats.missing_category || 0) +
                       (auditStats.missing_price || 0) +
                       (auditStats.missing_sku || 0) +
                       (auditStats.stock_tracking_off || 0) +
                       (auditStats.inventory_alerts_off || 0);

  document.getElementById('totalProducts').textContent = total.toLocaleString();
  document.getElementById('itemsWithIssues').textContent = withIssues.toLocaleString();
  document.getElementById('completionRate').textContent = completionRate + '%';
  document.getElementById('criticalIssues').textContent = criticalCount.toLocaleString();
}

function filterByIssue() {
  const issueType = document.getElementById('issueFilter').value;

  // Update active card state
  document.querySelectorAll('.audit-card').forEach(card => {
    if (card.dataset.issueType === issueType) {
      card.classList.add('active');
      activeAuditCard = card;
    } else {
      card.classList.remove('active');
    }
  });

  if (!issueType) {
    activeAuditCard = null;
  }

  filterData();
}

function filterData() {
  const searchTerm = document.getElementById('searchBox').value.toLowerCase();
  const issueFilter = document.getElementById('issueFilter').value;
  const categoryFilter = document.getElementById('categoryFilter').value;
  const issueCountFilter = document.getElementById('issueCountFilter').value;

  filteredData = allData.filter(item => {
    const matchesSearch = !searchTerm ||
      (item.item_name && item.item_name.toLowerCase().includes(searchTerm)) ||
      (item.variation_name && item.variation_name.toLowerCase().includes(searchTerm)) ||
      (item.sku && item.sku.toLowerCase().includes(searchTerm));

    const matchesIssue = !issueFilter || item[issueFilter] === true;

    const matchesCategory = !categoryFilter ||
      (categoryFilter === '__none__' && !item.category_name) ||
      item.category_name === categoryFilter;

    let matchesIssueCount = true;
    if (issueCountFilter) {
      const count = item.issue_count || 0;
      switch (issueCountFilter) {
        case '0': matchesIssueCount = count === 0; break;
        case '1-3': matchesIssueCount = count >= 1 && count <= 3; break;
        case '4-6': matchesIssueCount = count >= 4 && count <= 6; break;
        case '7+': matchesIssueCount = count >= 7; break;
      }
    }

    return matchesSearch && matchesIssue && matchesCategory && matchesIssueCount;
  });

  renderTable(filteredData);
  document.getElementById('statusBadge').textContent =
    `Showing ${filteredData.length} of ${allData.length} records`;
}

async function loadData() {
  showLoading();

  try {
    const response = await fetch('/api/catalog-audit');
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const result = await response.json();
    allData = result.items || [];
    auditStats = result.stats || {};

    if (allData.length === 0) {
      showError('No catalog data available');
      return;
    }

    // Populate category filter
    categories = new Set(allData.map(item => item.category_name).filter(Boolean));
    const categorySelect = document.getElementById('categoryFilter');
    categorySelect.innerHTML = '<option value="">All Categories</option>';
    categorySelect.innerHTML += '<option value="__none__">-- No Category --</option>';
    Array.from(categories).sort().forEach(category => {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      categorySelect.appendChild(option);
    });

    filteredData = allData;
    renderAuditCards();
    calculateStats(allData);
    renderTable(filteredData);
    showData();

    document.getElementById('statusBadge').textContent =
      `${allData.length} records - Updated: ${new Date().toLocaleTimeString()}`;

  } catch (error) {
    console.error('Error loading data:', error);
    showError(`Error: ${error.message}`);
  }
}

function sortTable(elementOrField, event, param) {
  // Support both: sortTable('field') and sortTable(element, event, param)
  const field = param || elementOrField;
  sortDirections[field] = !sortDirections[field];
  const ascending = sortDirections[field];
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
    if (['item_name', 'variation_name', 'sku', 'category_name', 'vendor_name'].includes(field)) {
      aVal = (aVal || '').toString().toLowerCase();
      bVal = (bVal || '').toString().toLowerCase();
    } else {
      aVal = parseFloat(aVal) || 0;
      bVal = parseFloat(bVal) || 0;
    }

    if (aVal === bVal) return 0;
    if (ascending) {
      return aVal > bVal ? 1 : -1;
    } else {
      return aVal < bVal ? 1 : -1;
    }
  });

  renderTable(filteredData);
}

function getIssueCountClass(count) {
  if (count === 0) return 'none';
  if (count <= 3) return 'low';
  if (count <= 6) return 'medium';
  return 'high';
}

function getIssueBadgeClass(issue) {
  const criticalIssues = ['No Category', 'No Price', 'No SKU', 'Stock Tracking Off', 'Inv Alerts Off', 'OOS, No Min'];
  const warningIssues = ['Not Taxable', 'No Description', 'No Image', 'No Vendor', 'No Cost', 'No Tax IDs'];
  const criticalIssues2 = ['Location Mismatch'];  // Additional critical issues
  const infoIssues = ['No UPC', 'Not Visible Online', 'No SEO Title', 'No SEO Description'];

  if (criticalIssues.includes(issue) || criticalIssues2.includes(issue)) return 'critical';
  if (warningIssues.includes(issue)) return 'warning';
  if (infoIssues.includes(issue)) return 'info';
  return 'info';
}

// Format velocity value with 2 decimal places
function formatVelocity(val) {
  if (!val || val === 0) return '-';
  return parseFloat(val).toFixed(2);
}

function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  data.forEach(item => {
    const row = document.createElement('tr');
    const price = (item.price_money || 0) / 100;
    const stock = parseFloat(item.current_stock || 0);
    const daysOfStock = item.days_of_stock;

    // Get image URL
    const imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    const imageHtml = imageUrl
      ? `<img src="${imageUrl}" class="product-image" alt="Product" data-fallback="true">
         <div class="no-image" style="display:none;">?</div>`
      : `<div class="no-image">?</div>`;

    // Build issues display
    const issues = item.issues || [];
    const issuesHtml = issues.length > 0
      ? issues.map(issue => `<span class="issue-badge ${getIssueBadgeClass(issue)}">${issue}</span>`).join('')
      : '<span class="issue-badge ok">All Good</span>';

    // Format velocity display (91d/182d/365d like reorder.html)
    const velocityText = `${formatVelocity(item.weekly_avg_91d)} / ${formatVelocity(item.weekly_avg_182d)} / ${formatVelocity(item.weekly_avg_365d)}`;
    const daysDisplay = daysOfStock !== null ? daysOfStock : '-';

    row.innerHTML = `
      <td>${imageHtml}</td>
      <td>
        <div class="product-name">${escapeHtml(item.item_name || 'Unknown Product')}</div>
        ${item.variation_name ? `<div class="variation-name">${escapeHtml(item.variation_name)}</div>` : ''}
      </td>
      <td><span class="sku">${escapeHtml(item.sku || '-')}</span></td>
      <td>${escapeHtml(item.category_name || '-')}</td>
      <td class="text-right">${price > 0 ? '$' + price.toFixed(2) : '-'}</td>
      <td class="text-right">${stock.toFixed(0)}</td>
      <td class="text-right"><small>${velocityText}</small></td>
      <td class="text-right">${daysDisplay}</td>
      <td class="text-right">
        <span class="issue-count ${getIssueCountClass(item.issue_count)}">${item.issue_count}</span>
      </td>
      <td class="issues-cell">${issuesHtml}</td>
    `;
    tbody.appendChild(row);
  });
}

function exportCSV() {
  if (filteredData.length === 0) {
    alert('No data to export');
    return;
  }

  const headers = [
    'Item Name',
    'Variation Name',
    'SKU',
    'UPC',
    'Category',
    'Price',
    'Stock',
    'Velocity 91d',
    'Velocity 182d',
    'Velocity 365d',
    'Days of Stock',
    'Issue Count',
    'Issues',
    'Missing Category',
    'Not Taxable',
    'Missing Price',
    'Missing Description',
    'Missing Image',
    'Missing SKU',
    'Missing UPC',
    'Stock Tracking Off',
    'Inventory Alerts Off',
    'OOS No Min Set',
    'Missing Vendor',
    'Missing Cost',
    'Not Visible Online',
    'Missing SEO Title',
    'Missing SEO Description',
    'No Tax IDs',
    'Location Mismatch'
  ];

  const rows = filteredData.map(item => [
    item.item_name || '',
    item.variation_name || '',
    item.sku || '',
    item.upc || '',
    item.category_name || '',
    (item.price_money || 0) / 100,
    item.current_stock || 0,
    item.weekly_avg_91d || 0,
    item.weekly_avg_182d || 0,
    item.weekly_avg_365d || 0,
    item.days_of_stock || '',
    item.issue_count || 0,
    (item.issues || []).join('; '),
    item.missing_category ? 'Yes' : 'No',
    item.not_taxable ? 'Yes' : 'No',
    item.missing_price ? 'Yes' : 'No',
    item.missing_description ? 'Yes' : 'No',
    item.missing_item_image ? 'Yes' : 'No',
    item.missing_sku ? 'Yes' : 'No',
    item.missing_upc ? 'Yes' : 'No',
    item.stock_tracking_off ? 'Yes' : 'No',
    item.inventory_alerts_off ? 'Yes' : 'No',
    item.no_reorder_threshold ? 'Yes' : 'No',
    item.missing_vendor ? 'Yes' : 'No',
    item.missing_cost ? 'Yes' : 'No',
    item.not_visible_online ? 'Yes' : 'No',
    item.missing_seo_title ? 'Yes' : 'No',
    item.missing_seo_description ? 'Yes' : 'No',
    item.no_tax_ids ? 'Yes' : 'No',
    item.location_mismatch ? 'Yes' : 'No'
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => {
      const str = String(cell);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(','))
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `catalog-audit-${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
}

async function fixLocationMismatches() {
  const btn = document.getElementById('fixLocationsBtn');
  const originalText = btn.textContent;
  document.getElementById('bulkEditsMenu').classList.remove('open');

  if (!confirm('This will set ALL items and variations to be available at ALL locations in Square.\n\nThis fixes "Location Mismatch" errors but may affect which locations can see/sell items.\n\nContinue?')) {
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Fixing...';

    const response = await fetch('/api/catalog-audit/fix-locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();

    if (result.success) {
      alert(`Success!\n\nFixed ${result.itemsFixed} items and ${result.variationsFixed} variations.\n\nPlease run a full sync to update local data.`);
      loadData();
    } else {
      alert(`Partial success:\n\nFixed ${result.itemsFixed} items and ${result.variationsFixed} variations.\n\nErrors:\n${result.errors?.join('\n') || 'Unknown error'}`);
      loadData();
    }
  } catch (error) {
    console.error('Fix location mismatches error:', error);
    alert('Failed to fix location mismatches: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function toggleBulkEdits() {
  var menu = document.getElementById('bulkEditsMenu');
  menu.classList.toggle('open');
}

async function fixInventoryAlerts() {
  var btn = document.getElementById('fixAlertsBtn');
  var originalText = btn.textContent;
  document.getElementById('bulkEditsMenu').classList.remove('open');

  if (!confirm('This will enable LOW_QUANTITY inventory alerts (threshold 0) on all variations that currently have alerts off.\n\nContinue?')) {
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Fixing...';

    var response = await fetch('/api/catalog-audit/fix-inventory-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    var result = await response.json();

    if (result.success) {
      alert('Success!\n\nEnabled alerts for ' + result.variationsFixed + ' of ' + result.totalFound + ' items.\n\nPlease run a full sync to update local data.');
      loadData();
    } else {
      alert('Partial success:\n\nEnabled alerts for ' + result.variationsFixed + ' of ' + result.totalFound + ' items.\n\nErrors:\n' + (result.errors ? result.errors.join('\n') : 'Unknown error'));
      loadData();
    }
  } catch (error) {
    console.error('Fix inventory alerts error:', error);
    alert('Failed to fix inventory alerts: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Global error handler for images with fallback (CSP compliant - replaces inline onerror)
document.addEventListener('error', function(e) {
  if (e.target.tagName === 'IMG' && e.target.dataset.fallback) {
    e.target.style.display = 'none';
    const fallback = e.target.nextElementSibling;
    if (fallback) {
      fallback.style.display = 'flex';
    }
  }
}, true);

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  var dropdown = document.getElementById('bulkEditsDropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    document.getElementById('bulkEditsMenu').classList.remove('open');
  }
});

// Load data on page load
loadData();

// Expose functions to global scope for event delegation
window.loadData = loadData;
window.exportCSV = exportCSV;
window.fixLocationMismatches = fixLocationMismatches;
window.fixInventoryAlerts = fixInventoryAlerts;
window.toggleBulkEdits = toggleBulkEdits;
window.sortTable = sortTable;
window.filterByIssue = filterByIssue;
window.filterData = filterData;
