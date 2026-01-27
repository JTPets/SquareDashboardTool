/**
 * Sales Velocity page JavaScript
 * Extracted for CSP compliance (P0-4 Phase 2)
 */

let currentData = [];

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

function getVelocityBadge(dailyAvg) {
  if (dailyAvg >= 1) {
    return '<span class="velocity-badge velocity-fast">Fast</span>';
  } else if (dailyAvg >= 0.1) {
    return '<span class="velocity-badge velocity-moderate">Moderate</span>';
  } else {
    return '<span class="velocity-badge velocity-slow">Slow</span>';
  }
}

function calculateStats(data) {
  const totalProducts = data.length;
  const totalDailyAvg = data.reduce((sum, item) => sum + parseFloat(item.daily_avg_quantity || 0), 0);
  const avgDailySales = totalProducts > 0 ? (totalDailyAvg / totalProducts).toFixed(2) : 0;
  const fastMovers = data.filter(item => parseFloat(item.daily_avg_quantity || 0) >= 1).length;
  const slowMovers = data.filter(item => parseFloat(item.daily_avg_quantity || 0) < 0.1).length;

  document.getElementById('totalProducts').textContent = totalProducts.toLocaleString();
  document.getElementById('avgDailySales').textContent = avgDailySales;
  document.getElementById('fastMovers').textContent = fastMovers.toLocaleString();
  document.getElementById('slowMovers').textContent = slowMovers.toLocaleString();
}

async function loadData() {
  const period = document.getElementById('period').value;
  showLoading();

  try {
    const response = await fetch(`/api/sales-velocity?period_days=${period}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const result = await response.json();
    currentData = result.sales_velocity || [];

    if (currentData.length === 0) {
      showError('No sales velocity data available for this period');
      return;
    }

    renderTable(currentData);
    calculateStats(currentData);
    showData();

    document.getElementById('lastUpdated').textContent =
      `${currentData.length} products • Last updated: ${new Date().toLocaleTimeString()}`;

  } catch (error) {
    console.error('Error loading data:', error);
    showError(`Error: ${error.message}`);
  }
}

function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  // Sort by daily average descending
  data.sort((a, b) => parseFloat(b.daily_avg_quantity || 0) - parseFloat(a.daily_avg_quantity || 0));

  data.forEach(item => {
    const row = document.createElement('tr');
    const dailyAvg = parseFloat(item.daily_avg_quantity || 0);

    row.innerHTML = `
      <td>
        <div class="product-name">${item.item_name || 'Unknown Product'}</div>
        ${item.variation_name ? `<div class="variation-name">${item.variation_name}</div>` : ''}
      </td>
      <td><span class="sku">${item.sku || '-'}</span></td>
      <td>${item.location_name || '-'}</td>
      <td class="text-right"><strong>${parseFloat(item.total_quantity_sold || 0).toFixed(1)}</strong></td>
      <td class="text-right">${item.period_days || '-'}</td>
      <td class="text-right"><strong>${dailyAvg.toFixed(2)}</strong></td>
      <td>${getVelocityBadge(dailyAvg)}</td>
    `;
    tbody.appendChild(row);
  });
}

// Load data on page load with default period
loadData();

// Expose functions to global scope for event delegation
window.loadData = loadData;
