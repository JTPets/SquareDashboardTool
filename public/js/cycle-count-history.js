/**
 * Cycle Count History page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

let allItems = [];
let filteredItems = [];

// Date helper functions
function setToday() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('start-date').value = today;
  document.getElementById('end-date').value = today;
  loadHistory();
}

function setLast7Days() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  document.getElementById('start-date').value = weekAgo.toISOString().split('T')[0];
  document.getElementById('end-date').value = today.toISOString().split('T')[0];
  loadHistory();
}

function setLast30Days() {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);
  document.getElementById('start-date').value = monthAgo.toISOString().split('T')[0];
  document.getElementById('end-date').value = today.toISOString().split('T')[0];
  loadHistory();
}

async function loadHistory() {
  const startDate = document.getElementById('start-date').value;
  const endDate = document.getElementById('end-date').value;

  const tbody = document.getElementById('history-body');
  tbody.innerHTML = '<tr><td colspan="12" class="loading">Loading...</td></tr>';

  try {
    let url = '/api/cycle-counts/history?';

    if (startDate && endDate) {
      url += `start_date=${startDate}&end_date=${endDate}`;
    } else if (startDate) {
      url += `start_date=${startDate}`;
    } else {
      // Default to last 30 days
      url = '/api/cycle-counts/history';
    }

    const response = await fetch(url);
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="loading">No cycle count history found for the selected date range</td></tr>';
      updateStats({
        total_counts: 0,
        accurate_counts: 0,
        inaccurate_counts: 0,
        accuracy_rate: 0,
        total_variance_units: 0,
        total_variance_value: 0
      });
      allItems = [];
      filteredItems = [];
      return;
    }

    allItems = data.items;

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

    updateStats(data.summary);
    filterHistory();

  } catch (error) {
    console.error('Failed to load history:', error);
    tbody.innerHTML = '<tr><td colspan="12" class="loading">Error: ' + escapeHtml(error.message) + '</td></tr>';
  }
}

function filterHistory() {
  const categoryFilter = document.getElementById('category-filter').value;

  filteredItems = allItems.filter(item => {
    const matchesCategory = !categoryFilter || item.category_name === categoryFilter;
    return matchesCategory;
  });

  renderTable(filteredItems);
}

function updateStats(summary) {
  document.getElementById('stat-total').textContent = summary.total_counts.toLocaleString();
  document.getElementById('stat-accurate').textContent = summary.accurate_counts.toLocaleString();
  document.getElementById('stat-inaccurate').textContent = summary.inaccurate_counts.toLocaleString();
  document.getElementById('stat-accuracy-rate').textContent = summary.accuracy_rate.toFixed(1) + '%';
  document.getElementById('stat-variance-units').textContent = summary.total_variance_units.toLocaleString();
  document.getElementById('stat-variance-value').textContent = '$' + summary.total_variance_value.toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function renderTable(items) {
  const tbody = document.getElementById('history-body');

  tbody.innerHTML = items.map(item => {
    const countDate = new Date(item.last_counted_date);
    const dateStr = countDate.toLocaleDateString('en-CA');
    const timeStr = countDate.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });

    const variance = item.variance || 0;
    const varianceClass = variance > 0 ? 'variance-positive' : (variance < 0 ? 'variance-negative' : 'variance-zero');
    const varianceSymbol = variance > 0 ? '+' : '';

    const statusClass = item.is_accurate ? 'accurate' : 'inaccurate';
    const statusText = item.is_accurate ? '✓ Accurate' : '✗ Inaccurate';

    return `<tr>
      <td>
        <div>${dateStr}</div>
        <div style="font-size: 11px; color: #6b7280;">${timeStr}</div>
      </td>
      <td>${item.item_name || 'N/A'}</td>
      <td>${item.variation_name || 'Regular'}</td>
      <td style="font-family: monospace; font-size: 12px;">${item.sku || 'N/A'}</td>
      <td>${item.category_name || 'Uncategorized'}</td>
      <td style="text-align: right;">${item.expected_quantity !== null ? item.expected_quantity : 'N/A'}</td>
      <td style="text-align: right;">${item.actual_quantity !== null ? item.actual_quantity : 'N/A'}</td>
      <td style="text-align: right;" class="${varianceClass}">
        <strong>${varianceSymbol}${variance}</strong>
      </td>
      <td style="text-align: right;" class="${varianceClass}">
        <strong>${varianceSymbol}$${Math.abs(item.variance_value || 0).toFixed(2)}</strong>
      </td>
      <td class="${statusClass}">${statusText}</td>
      <td>${item.counted_by || 'System'}</td>
      <td class="notes-cell">${item.notes || ''}</td>
    </tr>`;
  }).join('');
}

function clearFilters() {
  document.getElementById('start-date').value = '';
  document.getElementById('end-date').value = '';
  document.getElementById('category-filter').value = '';
  allItems = [];
  filteredItems = [];
  document.getElementById('history-body').innerHTML = '<tr><td colspan="12" class="loading">Select a date range to view cycle count history</td></tr>';
  updateStats({
    total_counts: 0,
    accurate_counts: 0,
    inaccurate_counts: 0,
    accuracy_rate: 0,
    total_variance_units: 0,
    total_variance_value: 0
  });
}

// Load last 30 days by default
window.addEventListener('DOMContentLoaded', () => {
  setLast30Days();
});

// Expose functions to global scope for event delegation
window.setToday = setToday;
window.setLast7Days = setLast7Days;
window.setLast30Days = setLast30Days;
window.loadHistory = loadHistory;
window.clearFilters = clearFilters;
window.filterHistory = filterHistory;
