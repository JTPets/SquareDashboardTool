/**
 * Delivery History Page Script
 * Handles viewing completed delivery history with POD photos
 */

let orders = [];

// Initialize with last 7 days
document.addEventListener('DOMContentLoaded', () => {
  setQuickRange('week');
  loadHistory();

  // Handle image errors for POD thumbnails via delegation
  document.addEventListener('error', function(event) {
    if (event.target.classList && event.target.classList.contains('pod-thumbnail')) {
      event.target.style.display = 'none';
    }
  }, true);

  // Handle POD thumbnail clicks via delegation
  document.addEventListener('click', function(event) {
    const thumbnail = event.target.closest('.pod-thumbnail');
    if (thumbnail) {
      const podId = thumbnail.dataset.podId;
      const customerName = thumbnail.dataset.customerName;
      const captureTime = thumbnail.dataset.captureTime;
      openPodModal(podId, customerName, captureTime);
    }

    // Stop propagation for modal content clicks
    if (event.target.closest('[data-modal-content]') && !event.target.closest('[data-action]')) {
      event.stopPropagation();
    }
  });

  // Close modal on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePodModal();
    }
  });
});

/**
 * Set quick date range filter
 * @param {HTMLElement} element - The triggering element
 * @param {Event} event - The DOM event
 * @param {string} range - Range type: 'today', 'week', or 'month'
 */
function setQuickRange(element, event, range) {
  // Handle both direct call and event delegation call
  const rangeValue = typeof element === 'string' ? element : range;

  const today = new Date();
  const dateTo = today.toISOString().split('T')[0];
  let dateFrom;

  if (rangeValue === 'today') {
    dateFrom = dateTo;
  } else if (rangeValue === 'week') {
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    dateFrom = weekAgo.toISOString().split('T')[0];
  } else if (rangeValue === 'month') {
    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 30);
    dateFrom = monthAgo.toISOString().split('T')[0];
  }

  document.getElementById('dateFrom').value = dateFrom;
  document.getElementById('dateTo').value = dateTo;
}

/**
 * Load delivery history from API
 */
async function loadHistory() {
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;

  if (!dateFrom || !dateTo) {
    showAlert('Please select both start and end dates', 'error');
    return;
  }

  const container = document.getElementById('ordersContainer');
  container.innerHTML = '<div class="loading">Loading delivery history...</div>';

  try {
    const params = new URLSearchParams({
      status: 'completed',
      includeCompleted: 'true',
      dateFrom,
      dateTo,
      limit: '500'
    });

    const response = await fetch(`/api/delivery/orders?${params}`);
    if (!response.ok) {
      throw new Error('Failed to fetch delivery history');
    }

    const data = await response.json();
    orders = data.orders || [];

    renderOrders();
    updateStats();
  } catch (error) {
    console.error('Error loading history:', error);
    showAlert('Failed to load delivery history: ' + error.message, 'error');
    container.innerHTML = '<div class="empty-state"><h3>Error loading history</h3><p>Please try again.</p></div>';
  }
}

/**
 * Update statistics display
 */
function updateStats() {
  const total = orders.length;
  const withPod = orders.filter(o => o.pod_id).length;
  const withoutPod = total - withPod;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statWithPod').textContent = withPod;
  document.getElementById('statWithoutPod').textContent = withoutPod;
}

/**
 * Render orders grid
 */
function renderOrders() {
  const container = document.getElementById('ordersContainer');

  if (orders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No deliveries found</h3>
        <p>No completed deliveries in the selected date range.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="order-grid">
      ${orders.map(order => renderOrderCard(order)).join('')}
    </div>
  `;
}

/**
 * Render a single order card
 * @param {Object} order - Order data
 * @returns {string} HTML string for the order card
 */
function renderOrderCard(order) {
  const date = order.updated_at ? new Date(order.updated_at).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }) : 'Unknown date';

  const hasPod = !!order.pod_id;
  const podTime = order.pod_captured_at ? new Date(order.pod_captured_at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }) : '';

  return `
    <div class="order-card">
      <div class="order-card-header">
        <h3>${escapeHtml(order.customer_name)}</h3>
        <div class="date">${date}</div>
      </div>
      <div class="order-card-body">
        <div class="order-address">${escapeHtml(order.address)}</div>
        <div class="order-meta">
          ${order.phone ? `<span>Phone: ${escapeHtml(order.phone)}</span>` : ''}
          ${order.square_order_id ? `<span>Square Order</span>` : '<span>Manual Order</span>'}
        </div>
      </div>
      <div class="pod-section ${hasPod ? '' : 'no-pod'}">
        <div class="pod-info">
          ${hasPod ? `<span>POD captured at ${podTime}</span>` : '<span>No POD photo</span>'}
        </div>
        ${hasPod ? `
          <img
            class="pod-thumbnail"
            src="/api/delivery/pod/${order.pod_id}"
            alt="POD"
            data-pod-id="${escapeHtml(order.pod_id)}"
            data-customer-name="${escapeHtml(order.customer_name)}"
            data-capture-time="${podTime}"
          >
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Open POD photo modal
 * @param {string} podId - POD ID
 * @param {string} customerName - Customer name
 * @param {string} captureTime - Time photo was captured
 */
function openPodModal(podId, customerName, captureTime) {
  document.getElementById('podModalTitle').textContent = `POD - ${customerName}`;
  document.getElementById('podModalImage').src = `/api/delivery/pod/${podId}`;
  document.getElementById('podModalInfo').textContent = captureTime ? `Captured at ${captureTime}` : '';
  document.getElementById('podModal').classList.add('active');
}

/**
 * Close POD modal
 */
function closePodModal() {
  document.getElementById('podModal').classList.remove('active');
}

/**
 * Close POD modal when clicking overlay
 * @param {HTMLElement} element - The overlay element
 * @param {Event} event - The DOM event
 */
function closePodModalOverlay(element, event) {
  // Only close if clicking directly on overlay, not on modal content
  if (event.target.id === 'podModal') {
    closePodModal();
  }
}

/**
 * Show alert message
 * @param {string} message - Message to display
 * @param {string} type - Alert type: 'error' or 'success'
 */
function showAlert(message, type) {
  const alertArea = document.getElementById('alertArea');
  alertArea.innerHTML = `<div class="alert alert-${type}">${escapeHtml(message)}</div>`;
  setTimeout(() => { alertArea.innerHTML = ''; }, 5000);
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Expose functions to global scope for event delegation
window.loadHistory = loadHistory;
window.setQuickRange = setQuickRange;
window.closePodModal = closePodModal;
window.closePodModalOverlay = closePodModalOverlay;
