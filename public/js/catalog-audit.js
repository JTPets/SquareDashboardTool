/**
 * Catalog Audit page JavaScript
 * Externalized from catalog-audit.html for CSP compliance (P0-4 Phase 2)
 *
 * Lazy loading: summary cards load on page init, item-level detail loads on demand
 * Catalog Health section: super admin only, loads separately
 */

let allData = [];
let filteredData = [];
let auditStats = {};
let categories = new Set();
let currentSortField = null;
let sortDirections = {};
let activeAuditCard = null;
let detailDataLoaded = false;
let healthIssues = [];
let healthFilteredIssues = [];

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

// ============================================================================
// UI state helpers
// ============================================================================

function showSummaryLoading() {
  document.getElementById('summaryLoading').style.display = 'block';
  document.querySelector('.error').style.display = 'none';
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
  document.getElementById('auditSummary').style.display = 'none';
  document.getElementById('detailPrompt').style.display = 'none';
  document.getElementById('detailLoading').style.display = 'none';
}

function showError(message) {
  document.getElementById('summaryLoading').style.display = 'none';
  document.querySelector('.error').style.display = 'block';
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
  document.getElementById('auditSummary').style.display = 'none';
  document.getElementById('detailPrompt').style.display = 'none';
  document.getElementById('detailLoading').style.display = 'none';
}

function showSummary() {
  document.getElementById('summaryLoading').style.display = 'none';
  document.querySelector('.error').style.display = 'none';
  document.getElementById('statsBar').style.display = 'grid';
  document.getElementById('auditSummary').style.display = 'block';
  // Show detail prompt only if detail data not yet loaded
  if (!detailDataLoaded) {
    document.getElementById('detailPrompt').style.display = 'block';
    document.getElementById('dataTable').style.display = 'none';
  }
}

function showDetailTable() {
  document.getElementById('detailPrompt').style.display = 'none';
  document.getElementById('detailLoading').style.display = 'none';
  document.getElementById('dataTable').style.display = 'table';
}

function getSeverityClass(count, total) {
  const percent = (count / total) * 100;
  if (percent > 20) return 'critical';
  if (percent > 5) return 'warning';
  return 'good';
}

// ============================================================================
// Summary / cards
// ============================================================================

function renderAuditCards() {
  const grid = document.getElementById('auditGrid');
  grid.innerHTML = '';

  const total = auditStats.total_items;

  AUDIT_TYPES.forEach(audit => {
    const count = auditStats[audit.key] || 0;
    const percent = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
    const severityClass = count === 0 ? 'good' : getSeverityClass(count, total);

    const card = document.createElement('div');
    card.className = 'audit-card ' + severityClass;
    card.dataset.issueType = audit.key;
    card.onclick = function() { selectAuditCard(audit.key, card); };

    card.innerHTML =
      '<div class="card-header"><span class="card-title">' + audit.label + '</span></div>' +
      '<div class="card-value">' + count.toLocaleString() + '</div>' +
      '<div class="card-percent">' + percent + '% of catalog</div>' +
      (audit.note ? '<div class="card-note">' + audit.note + '</div>' : '');

    grid.appendChild(card);
  });
}

function selectAuditCard(issueType, card) {
  if (activeAuditCard === card) {
    card.classList.remove('active');
    activeAuditCard = null;
    document.getElementById('issueFilter').value = '';
    if (detailDataLoaded) filterData();
  } else {
    if (activeAuditCard) activeAuditCard.classList.remove('active');
    card.classList.add('active');
    activeAuditCard = card;
    document.getElementById('issueFilter').value = issueType;
    // Auto-load detail data on card click if not loaded
    if (!detailDataLoaded) {
      loadDetailData();
    } else {
      filterByIssue();
    }
  }
}

function calculateStats() {
  const total = auditStats.total_items;
  const withIssues = auditStats.items_with_issues;
  const completionRate = total > 0 ? (((total - withIssues) / total) * 100).toFixed(1) : 100;

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

// ============================================================================
// Filter + sort
// ============================================================================

function filterByIssue() {
  const issueType = document.getElementById('issueFilter').value;

  document.querySelectorAll('.audit-card').forEach(function(card) {
    if (card.dataset.issueType === issueType) {
      card.classList.add('active');
      activeAuditCard = card;
    } else {
      card.classList.remove('active');
    }
  });

  if (!issueType) activeAuditCard = null;
  if (detailDataLoaded) filterData();
}

function filterData() {
  if (!detailDataLoaded) return;
  const searchTerm = document.getElementById('searchBox').value.toLowerCase();
  const issueFilter = document.getElementById('issueFilter').value;
  const categoryFilter = document.getElementById('categoryFilter').value;
  const issueCountFilter = document.getElementById('issueCountFilter').value;

  filteredData = allData.filter(function(item) {
    var matchesSearch = !searchTerm ||
      (item.item_name && item.item_name.toLowerCase().includes(searchTerm)) ||
      (item.variation_name && item.variation_name.toLowerCase().includes(searchTerm)) ||
      (item.sku && item.sku.toLowerCase().includes(searchTerm));

    var matchesIssue = !issueFilter || item[issueFilter] === true;

    var matchesCategory = !categoryFilter ||
      (categoryFilter === '__none__' && !item.category_name) ||
      item.category_name === categoryFilter;

    var matchesIssueCount = true;
    if (issueCountFilter) {
      var count = item.issue_count || 0;
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
    'Showing ' + filteredData.length + ' of ' + allData.length + ' records';
}

function sortTable(elementOrField, event, param) {
  var field = param || elementOrField;
  sortDirections[field] = !sortDirections[field];
  var ascending = sortDirections[field];
  currentSortField = field;

  document.querySelectorAll('.sort-indicator').forEach(function(el) {
    el.className = 'sort-indicator';
  });

  var indicator = document.getElementById('sort-' + field);
  if (indicator) {
    indicator.className = 'sort-indicator ' + (ascending ? 'asc' : 'desc');
  }

  filteredData.sort(function(a, b) {
    var aVal = a[field];
    var bVal = b[field];

    if (['item_name', 'variation_name', 'sku', 'category_name', 'vendor_name'].includes(field)) {
      aVal = (aVal || '').toString().toLowerCase();
      bVal = (bVal || '').toString().toLowerCase();
    } else {
      aVal = parseFloat(aVal) || 0;
      bVal = parseFloat(bVal) || 0;
    }

    if (aVal === bVal) return 0;
    return ascending ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
  });

  renderTable(filteredData);
}

// ============================================================================
// Data loading — lazy: summary first, detail on demand
// ============================================================================

async function loadData() {
  showSummaryLoading();
  detailDataLoaded = false;

  try {
    var response = await fetch('/api/catalog-audit');
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + response.statusText);

    var result = await response.json();
    allData = result.items || [];
    auditStats = result.stats || {};

    if (allData.length === 0) {
      showError('No catalog data available');
      return;
    }

    // Populate category filter
    categories = new Set(allData.map(function(item) { return item.category_name; }).filter(Boolean));
    var categorySelect = document.getElementById('categoryFilter');
    categorySelect.innerHTML = '<option value="">All Categories</option>';
    categorySelect.innerHTML += '<option value="__none__">-- No Category --</option>';
    Array.from(categories).sort().forEach(function(category) {
      var option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      categorySelect.appendChild(option);
    });

    filteredData = allData;
    renderAuditCards();
    calculateStats();
    showSummary();

    document.getElementById('statusBadge').textContent =
      allData.length + ' records - Updated: ' + new Date().toLocaleTimeString();

  } catch (error) {
    console.error('Error loading data:', error);
    showError('Error: ' + error.message);
  }
}

/**
 * Load item-level detail data (lazy — triggered by user action)
 */
async function loadDetailData() {
  if (detailDataLoaded) {
    filterData();
    showDetailTable();
    return;
  }

  document.getElementById('detailPrompt').style.display = 'none';
  document.getElementById('detailLoading').style.display = 'block';

  // If allData is already loaded from summary call, just render it
  if (allData.length > 0) {
    detailDataLoaded = true;
    filterData();
    showDetailTable();
    return;
  }

  // Fallback: fetch if not loaded yet
  try {
    var response = await fetch('/api/catalog-audit');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var result = await response.json();
    allData = result.items || [];
    auditStats = result.stats || {};

    detailDataLoaded = true;
    filteredData = allData;
    filterData();
    showDetailTable();
  } catch (error) {
    document.getElementById('detailLoading').style.display = 'none';
    showError('Error loading detail data: ' + error.message);
  }
}

// ============================================================================
// Rendering
// ============================================================================

function getIssueCountClass(count) {
  if (count === 0) return 'none';
  if (count <= 3) return 'low';
  if (count <= 6) return 'medium';
  return 'high';
}

function getIssueBadgeClass(issue) {
  var criticalIssues = ['No Category', 'No Price', 'No SKU', 'Stock Tracking Off', 'Inv Alerts Off', 'OOS, No Min'];
  var warningIssues = ['Not Taxable', 'No Description', 'No Image', 'No Vendor', 'No Cost', 'No Tax IDs'];
  var criticalIssues2 = ['Location Mismatch'];
  var infoIssues = ['No UPC', 'Not Visible Online', 'No SEO Title', 'No SEO Description'];

  if (criticalIssues.includes(issue) || criticalIssues2.includes(issue)) return 'critical';
  if (warningIssues.includes(issue)) return 'warning';
  if (infoIssues.includes(issue)) return 'info';
  return 'info';
}

function formatVelocity(val) {
  if (!val || val === 0) return '-';
  return parseFloat(val).toFixed(2);
}

function renderTable(data) {
  var tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  data.forEach(function(item) {
    var row = document.createElement('tr');
    var price = (item.price_money || 0) / 100;
    var stock = parseFloat(item.current_stock || 0);
    var daysOfStock = item.days_of_stock;

    var imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    var imageHtml = imageUrl
      ? '<img src="' + escapeAttr(imageUrl) + '" class="product-image" alt="Product" data-fallback="true"><div class="no-image" style="display:none;">?</div>'
      : '<div class="no-image">?</div>';

    var issues = item.issues || [];
    var issuesHtml = issues.length > 0
      ? issues.map(function(issue) { return '<span class="issue-badge ' + getIssueBadgeClass(issue) + '">' + escapeHtml(issue) + '</span>'; }).join('')
      : '<span class="issue-badge ok">All Good</span>';

    var velocityText = formatVelocity(item.weekly_avg_91d) + ' / ' + formatVelocity(item.weekly_avg_182d) + ' / ' + formatVelocity(item.weekly_avg_365d);
    var daysDisplay = daysOfStock !== null ? daysOfStock : '-';

    row.innerHTML =
      '<td>' + imageHtml + '</td>' +
      '<td><div class="product-name">' + escapeHtml(item.item_name || 'Unknown Product') + '</div>' +
        (item.variation_name ? '<div class="variation-name">' + escapeHtml(item.variation_name) + '</div>' : '') +
      '</td>' +
      '<td><span class="sku">' + escapeHtml(item.sku || '-') + '</span></td>' +
      '<td>' + escapeHtml(item.category_name || '-') + '</td>' +
      '<td class="text-right">' + (price > 0 ? '$' + price.toFixed(2) : '-') + '</td>' +
      '<td class="text-right">' + stock.toFixed(0) + '</td>' +
      '<td class="text-right"><small>' + velocityText + '</small></td>' +
      '<td class="text-right">' + daysDisplay + '</td>' +
      '<td class="text-right"><span class="issue-count ' + getIssueCountClass(item.issue_count) + '">' + item.issue_count + '</span></td>' +
      '<td class="issues-cell">' + issuesHtml + '</td>';
    tbody.appendChild(row);
  });
}

// ============================================================================
// CSV export
// ============================================================================

function exportCSV() {
  if (filteredData.length === 0) {
    alert('No data to export');
    return;
  }

  var headers = [
    'Item Name', 'Variation Name', 'SKU', 'UPC', 'Category', 'Price', 'Stock',
    'Velocity 91d', 'Velocity 182d', 'Velocity 365d', 'Days of Stock',
    'Issue Count', 'Issues', 'Missing Category', 'Not Taxable', 'Missing Price',
    'Missing Description', 'Missing Image', 'Missing SKU', 'Missing UPC',
    'Stock Tracking Off', 'Inventory Alerts Off', 'OOS No Min Set',
    'Missing Vendor', 'Missing Cost', 'Not Visible Online',
    'Missing SEO Title', 'Missing SEO Description', 'No Tax IDs', 'Location Mismatch'
  ];

  var rows = filteredData.map(function(item) {
    return [
      item.item_name || '', item.variation_name || '', item.sku || '', item.upc || '',
      item.category_name || '', (item.price_money || 0) / 100, item.current_stock || 0,
      item.weekly_avg_91d || 0, item.weekly_avg_182d || 0, item.weekly_avg_365d || 0,
      item.days_of_stock || '', item.issue_count || 0, (item.issues || []).join('; '),
      item.missing_category ? 'Yes' : 'No', item.not_taxable ? 'Yes' : 'No',
      item.missing_price ? 'Yes' : 'No', item.missing_description ? 'Yes' : 'No',
      item.missing_item_image ? 'Yes' : 'No', item.missing_sku ? 'Yes' : 'No',
      item.missing_upc ? 'Yes' : 'No', item.stock_tracking_off ? 'Yes' : 'No',
      item.inventory_alerts_off ? 'Yes' : 'No', item.no_reorder_threshold ? 'Yes' : 'No',
      item.missing_vendor ? 'Yes' : 'No', item.missing_cost ? 'Yes' : 'No',
      item.not_visible_online ? 'Yes' : 'No', item.missing_seo_title ? 'Yes' : 'No',
      item.missing_seo_description ? 'Yes' : 'No', item.no_tax_ids ? 'Yes' : 'No',
      item.location_mismatch ? 'Yes' : 'No'
    ];
  });

  var csvContent = [
    headers.join(','),
    ...rows.map(function(row) {
      return row.map(function(cell) {
        var str = String(cell);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(',');
    })
  ].join('\n');

  var blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'catalog-audit-' + new Date().toISOString().split('T')[0] + '.csv';
  link.click();
}

// ============================================================================
// Bulk edit actions
// ============================================================================

async function fixLocationMismatches() {
  var btn = document.getElementById('fixLocationsBtn');
  var originalText = btn.textContent;
  document.getElementById('bulkEditsMenu').classList.remove('open');

  if (!confirm('This will set ALL items and variations to be available at ALL locations in Square.\n\nThis fixes "Location Mismatch" errors but may affect which locations can see/sell items.\n\nContinue?')) {
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Fixing...';

    var response = await fetch('/api/catalog-audit/fix-locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    var result = await response.json();

    if (result.success) {
      alert('Success!\n\nFixed ' + result.itemsFixed + ' items and ' + result.variationsFixed + ' variations.\n\nPlease run a full sync to update local data.');
      loadData();
    } else {
      alert('Partial success:\n\nFixed ' + result.itemsFixed + ' items and ' + result.variationsFixed + ' variations.\n\nErrors:\n' + (result.errors ? result.errors.join('\n') : 'Unknown error'));
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

// ============================================================================
// Catalog Health Monitor (super admin only)
// ============================================================================

var CHECK_TYPE_LABELS = {
  location_mismatch: 'Location Mismatch',
  orphaned_variation: 'Orphaned Variation',
  deleted_parent: 'Deleted Parent',
  category_orphan: 'Category Orphan',
  image_orphan: 'Image Orphan',
  modifier_orphan: 'Modifier Orphan',
  pricing_rule_orphan: 'Pricing Rule Orphan',
  missing_tax: 'Missing Tax'
};

async function checkCatalogHealthAccess() {
  try {
    var response = await fetch('/api/admin/catalog-health');
    if (response.ok) {
      document.getElementById('catalogHealthSection').style.display = 'block';
      var data = await response.json();
      renderHealthSummary(data.openIssues || []);
    }
  } catch (e) {
    // Not admin — section stays hidden
  }
}

function renderHealthSummary(openIssues) {
  healthIssues = openIssues;
  var container = document.getElementById('healthSummaryCards');

  // Count by check_type and severity
  var errorCount = 0;
  var warnCount = 0;
  var byType = {};

  openIssues.forEach(function(issue) {
    var ct = issue.check_type || issue.mismatch_type || 'unknown';
    if (!byType[ct]) byType[ct] = 0;
    byType[ct]++;
    if (issue.severity === 'warn') warnCount++;
    else errorCount++;
  });

  var totalOpen = openIssues.length;

  // Build summary cards
  var html = '';

  // Total card
  var totalClass = totalOpen === 0 ? 'good' : (errorCount > 0 ? 'critical' : 'warning');
  html += '<div class="audit-card ' + totalClass + '" style="cursor:pointer;" onclick="showAllHealthIssues()">' +
    '<div class="card-header"><span class="card-title">TOTAL OPEN</span></div>' +
    '<div class="card-value">' + totalOpen + '</div>' +
    '<div class="card-percent">' + errorCount + ' errors, ' + warnCount + ' warnings</div></div>';

  // Per-type cards
  Object.keys(CHECK_TYPE_LABELS).forEach(function(checkType) {
    var count = byType[checkType] || 0;
    var cardClass = count === 0 ? 'good' : (checkType === 'missing_tax' ? 'warning' : 'critical');
    html += '<div class="audit-card ' + cardClass + '" style="cursor:pointer;" onclick="filterHealthByType(\'' + escapeAttr(checkType) + '\')">' +
      '<div class="card-header"><span class="card-title">' + CHECK_TYPE_LABELS[checkType] + '</span></div>' +
      '<div class="card-value">' + count + '</div></div>';
  });

  container.innerHTML = html;

  // Show detail prompt if there are issues
  if (totalOpen > 0) {
    document.getElementById('healthDetailPrompt').style.display = 'block';
  } else {
    document.getElementById('healthDetailPrompt').style.display = 'block';
    document.getElementById('healthDetailPrompt').innerHTML =
      '<p style="color: #059669; font-weight: 600;">No open catalog health issues found.</p>';
  }
}

function showAllHealthIssues() {
  healthFilteredIssues = healthIssues;
  document.getElementById('healthCheckTypeFilter').value = '';
  renderHealthTable(healthIssues);
}

function filterHealthByType(checkType) {
  document.getElementById('healthCheckTypeFilter').value = checkType;
  filterHealthIssues();
}

function filterHealthIssues() {
  var typeFilter = document.getElementById('healthCheckTypeFilter').value;
  if (typeFilter) {
    healthFilteredIssues = healthIssues.filter(function(i) {
      return (i.check_type || i.mismatch_type) === typeFilter;
    });
  } else {
    healthFilteredIssues = healthIssues;
  }
  renderHealthTable(healthFilteredIssues);
}

function renderHealthTable(issues) {
  document.getElementById('healthDetailPrompt').style.display = 'none';
  document.getElementById('healthFilterRow').style.display = 'block';
  document.getElementById('healthTableContainer').style.display = 'block';

  var tbody = document.getElementById('healthTableBody');
  if (issues.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#6b7280;">No issues match filter</td></tr>';
    return;
  }

  tbody.innerHTML = issues.map(function(issue) {
    var ct = issue.check_type || issue.mismatch_type || '';
    var severityBadge = issue.severity === 'warn'
      ? '<span class="issue-badge warning">warn</span>'
      : '<span class="issue-badge critical">error</span>';
    var detected = issue.detected_at ? new Date(issue.detected_at).toLocaleString() : '-';

    return '<tr>' +
      '<td style="padding:10px; border-bottom:1px solid #e5e7eb;">' + escapeHtml(CHECK_TYPE_LABELS[ct] || ct) + '</td>' +
      '<td style="padding:10px; border-bottom:1px solid #e5e7eb; font-family:monospace; font-size:12px;">' + escapeHtml(issue.variation_id || '') + '</td>' +
      '<td style="padding:10px; border-bottom:1px solid #e5e7eb;">' + escapeHtml(issue.object_type || 'ITEM_VARIATION') + '</td>' +
      '<td style="padding:10px; border-bottom:1px solid #e5e7eb;">' + severityBadge + '</td>' +
      '<td style="padding:10px; border-bottom:1px solid #e5e7eb; font-size:12px;">' + detected + '</td>' +
      '<td style="padding:10px; border-bottom:1px solid #e5e7eb; font-size:12px; color:#6b7280;">' + escapeHtml(issue.notes || '') + '</td>' +
      '</tr>';
  }).join('');
}

async function runHealthCheck() {
  var btn = document.getElementById('healthCheckBtn');
  btn.disabled = true;
  btn.textContent = 'Running...';

  try {
    var response = await fetch('/api/admin/catalog-health/check', { method: 'POST' });
    var data = await response.json();

    if (response.ok) {
      var resultDiv = document.getElementById('healthCheckResult');
      resultDiv.style.display = 'block';
      var newCount = data.newIssues ? data.newIssues.length : 0;
      var resolvedCount = data.resolved ? data.resolved.length : 0;
      var checkedItems = data.checked ? data.checked.items : 0;
      var checkedVars = data.checked ? data.checked.variations : 0;
      resultDiv.textContent = 'Checked ' + checkedItems + ' items, ' + checkedVars + ' variations' +
        ' | New issues: ' + newCount +
        ' | Resolved: ' + resolvedCount +
        ' | Existing open: ' + (data.existingOpen || 0) +
        ' | Duration: ' + (data.durationMs || 0) + 'ms';

      // Refresh the health summary
      checkCatalogHealthAccess();
    } else {
      alert('Health check failed: ' + (data.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Health check failed: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Health Check Now';
  }
}

// ============================================================================
// Event listeners + init
// ============================================================================

// Global error handler for images with fallback (CSP compliant)
document.addEventListener('error', function(e) {
  if (e.target.tagName === 'IMG' && e.target.dataset.fallback) {
    e.target.style.display = 'none';
    var fallback = e.target.nextElementSibling;
    if (fallback) fallback.style.display = 'flex';
  }
}, true);

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  var dropdown = document.getElementById('bulkEditsDropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    document.getElementById('bulkEditsMenu').classList.remove('open');
  }
});

// Load summary on page load (lazy — no item-level detail)
loadData();

// Check admin access for health section
checkCatalogHealthAccess();

// Expose functions to global scope for event delegation
window.loadData = loadData;
window.loadDetailData = loadDetailData;
window.exportCSV = exportCSV;
window.fixLocationMismatches = fixLocationMismatches;
window.fixInventoryAlerts = fixInventoryAlerts;
window.toggleBulkEdits = toggleBulkEdits;
window.sortTable = sortTable;
window.filterByIssue = filterByIssue;
window.filterData = filterData;
window.runHealthCheck = runHealthCheck;
window.showAllHealthIssues = showAllHealthIssues;
window.filterHealthByType = filterHealthByType;
window.filterHealthIssues = filterHealthIssues;
