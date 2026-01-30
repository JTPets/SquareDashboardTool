/**
 * Delivery Scheduler page JavaScript
 * Externalized from delivery.html for CSP compliance (P0-4 Phase 2)
 */

// State
let orders = { pending: [], active: [], completed: [] };
let activeRoute = null;

// Tab switching
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Initial load
  loadOrders();

  // Refresh every 30 seconds
  setInterval(loadOrders, 30000);
});

async function loadOrders() {
  try {
    // Load all orders
    const [pendingRes, activeRes, completedRes, statsRes] = await Promise.all([
      fetch('/api/delivery/orders?status=pending'),
      fetch('/api/delivery/orders?status=active,skipped,delivered'),
      fetch('/api/delivery/orders?status=completed&includeCompleted=true'),
      fetch('/api/delivery/stats')
    ]);

    const pendingData = await pendingRes.json();
    const activeData = await activeRes.json();
    const completedData = await completedRes.json();

    // Handle stats separately to prevent one endpoint failure from breaking the whole page
    let statsData = { stats: null };
    try {
      statsData = await statsRes.json();
    } catch (e) {
      console.warn('Failed to parse stats response:', e);
    }

    orders.pending = pendingData.orders || [];
    orders.active = activeData.orders || [];
    orders.completed = completedData.orders || [];

    renderOrders();
    updateStats(statsData.stats);

    // Check for active route
    const routeRes = await fetch('/api/delivery/route/active');
    const routeData = await routeRes.json();
    if (routeData.route) {
      activeRoute = routeData.route;
      showRouteBanner(activeRoute);
    } else {
      activeRoute = null;
      document.getElementById('routeBanner').classList.remove('active');
    }
  } catch (error) {
    console.error('Error loading orders:', error);
    showAlert('Failed to load orders: ' + error.message, 'error');
  }
}

function renderOrders() {
  renderOrderList('pendingOrders', orders.pending, 'pending');
  renderOrderList('activeOrders', orders.active, 'active');
  renderOrderList('completedOrders', orders.completed.filter(o => {
    const today = new Date().toISOString().split('T')[0];
    return o.updated_at && o.updated_at.startsWith(today);
  }), 'completed');

  // Update badges
  document.getElementById('pendingBadge').textContent = orders.pending.length;
  document.getElementById('activeBadge').textContent = orders.active.length;
  const todayCompleted = orders.completed.filter(o => {
    const today = new Date().toISOString().split('T')[0];
    return o.updated_at && o.updated_at.startsWith(today);
  });
  document.getElementById('completedBadge').textContent = todayCompleted.length;
}

function renderOrderList(containerId, orderList, type) {
  const container = document.getElementById(containerId);

  if (orderList.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No ${type} orders</h3>
        <p>${type === 'pending' ? 'Orders from Square will appear here automatically.' : 'No orders in this status.'}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = orderList.map(order => `
    <div class="order-card ${!order.geocoded_at ? 'needs-geocode' : ''} ${order.needs_customer_refresh ? 'needs-refresh' : ''}">
      <div class="order-info">
        <h3>${escapeHtml(order.customer_name)}${order.needs_customer_refresh || order.customer_name === 'Unknown Customer' ? ' <span class="badge-pending" title="Customer data pending - will update when order is confirmed">&#8987;</span>' : ''}</h3>
        <div class="order-address">${escapeHtml(order.address)}</div>
        <div class="order-meta">
          ${order.phone ? `<span>Phone: ${escapeHtml(order.phone)}</span>` : ''}
          <span class="status-badge status-${order.status}">${order.status}</span>
          ${order.square_order_id ? '<span>Square Order</span>' : '<span>Manual</span>'}
          ${order.square_order_state === 'DRAFT' ? '<span class="badge-draft" title="Order is still in DRAFT state">Draft</span>' : ''}
          ${!order.geocoded_at ? '<span style="color: #f59e0b;">Needs Geocoding</span>' : ''}
          ${order.route_position ? `<span>Stop #${order.route_position}</span>` : ''}
        </div>
        ${order.notes ? `<div class="order-notes">${escapeHtml(order.notes)}</div>` : ''}
      </div>
      <div class="order-actions">
        ${getOrderActions(order, type)}
      </div>
    </div>
  `).join('');
}

function getOrderActions(order, type) {
  let actions = '';

  if (type === 'pending') {
    actions += `<button class="btn btn-secondary" data-action="editOrder" data-action-param="${escapeHtml(order.id)}">Edit</button>`;
    if (!order.square_order_id) {
      actions += `<button class="btn btn-danger" data-action="deleteOrder" data-action-param="${escapeHtml(order.id)}">Delete</button>`;
    }
  } else if (type === 'active' && order.status !== 'completed') {
    actions += `<button class="btn btn-secondary" data-action="editOrder" data-action-param="${escapeHtml(order.id)}">Edit Notes</button>`;
  }

  return actions;
}

function updateStats(stats) {
  // Handle undefined stats (e.g., if stats endpoint failed)
  if (!stats) {
    stats = { byStatus: {}, completedToday: 0 };
  }
  document.getElementById('statPending').textContent = stats.byStatus?.pending || 0;
  document.getElementById('statActive').textContent = stats.byStatus?.active || 0;
  document.getElementById('statCompleted').textContent = stats.completedToday || 0;

  // Count orders needing geocode
  const needsGeocode = orders.pending.filter(o => !o.geocoded_at).length;
  document.getElementById('statNeedsGeocode').textContent = needsGeocode;

  // Disable generate route if no geocoded pending orders
  const geocodedPending = orders.pending.filter(o => o.geocoded_at).length;
  document.getElementById('generateRouteBtn').disabled = geocodedPending === 0;
  document.getElementById('geocodeBtn').disabled = needsGeocode === 0;
}

function showRouteBanner(route) {
  const banner = document.getElementById('routeBanner');
  banner.classList.add('active');

  const completed = route.completed_count || 0;
  const total = route.order_count || route.total_stops || 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  document.getElementById('routeDate').textContent = route.route_date || 'Today';
  document.getElementById('routeProgressText').textContent = `${completed}/${total} stops completed`;
  document.getElementById('routeProgressBar').style.width = percent + '%';
}

// Modal functions
function showAddOrderModal() {
  document.getElementById('addOrderForm').reset();
  document.getElementById('addOrderModal').classList.add('active');
}

function parseAddressString(address) {
  // Try to parse address in format: "street, unit, city, postal, country" or "street, city, postal, country"
  if (!address) return { street: '', unit: '', city: '', postalCode: '', country: '' };

  const parts = address.split(',').map(p => p.trim());

  if (parts.length >= 4) {
    // Check if second part looks like a unit (contains apt, suite, unit, #, or is short)
    const secondPart = parts[1].toLowerCase();
    const looksLikeUnit = secondPart.includes('apt') || secondPart.includes('suite') ||
                         secondPart.includes('unit') || secondPart.includes('#') ||
                         parts[1].length <= 10;

    if (parts.length >= 5 && looksLikeUnit) {
      // Format: street, unit, city, postal, country
      return {
        street: parts[0],
        unit: parts[1],
        city: parts[2],
        postalCode: parts[3],
        country: parts.slice(4).join(', ')
      };
    } else {
      // Format: street, city, postal, country (no unit)
      return {
        street: parts[0],
        unit: '',
        city: parts[1],
        postalCode: parts[2],
        country: parts.slice(3).join(', ')
      };
    }
  }

  // Can't parse - put everything in street for user to fix
  return { street: address, unit: '', city: '', postalCode: '', country: '' };
}

function editOrder(element, event, orderId) {
  // Support both direct call editOrder(id) and event delegation editOrder(el, ev, id)
  if (typeof element === 'string') {
    orderId = element;
  }
  const order = [...orders.pending, ...orders.active, ...orders.completed].find(o => o.id === orderId);
  if (!order) return;

  const addr = parseAddressString(order.address);

  document.getElementById('editOrderId').value = order.id;
  document.getElementById('editCustomerName').value = order.customer_name || '';
  document.getElementById('editStreet').value = addr.street;
  document.getElementById('editUnit').value = addr.unit;
  document.getElementById('editCity').value = addr.city;
  document.getElementById('editPostalCode').value = addr.postalCode;
  document.getElementById('editCountry').value = addr.country;
  document.getElementById('editPhone').value = order.phone || '';
  document.getElementById('editNotes').value = order.notes || '';
  document.getElementById('editOrderModal').classList.add('active');
}

function closeModal(element, event, modalId) {
  // Support both direct call closeModal(id) and event delegation closeModal(el, ev, id)
  if (typeof element === 'string') {
    modalId = element;
  }
  document.getElementById(modalId).classList.remove('active');
}

function buildAddressString(street, unit, city, postalCode, country) {
  let address = street;
  if (unit) address += ', ' + unit;
  address += ', ' + city;
  address += ', ' + postalCode;
  address += ', ' + country;
  return address;
}

async function submitAddOrder(element, e) {
  // Support both direct call and event delegation
  if (element && element.preventDefault) {
    e = element;
  }
  if (e) e.preventDefault();

  const address = buildAddressString(
    document.getElementById('orderStreet').value,
    document.getElementById('orderUnit').value,
    document.getElementById('orderCity').value,
    document.getElementById('orderPostalCode').value,
    document.getElementById('orderCountry').value
  );

  try {
    const response = await fetch('/api/delivery/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: document.getElementById('orderCustomerName').value,
        address: address,
        phone: document.getElementById('orderPhone').value || null,
        notes: document.getElementById('orderNotes').value || null
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    closeModal('addOrderModal');
    showAlert('Order added successfully!', 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to add order: ' + error.message, 'error');
  }
}

async function submitEditOrder(element, e) {
  // Support both direct call and event delegation
  if (element && element.preventDefault) {
    e = element;
  }
  if (e) e.preventDefault();

  const orderId = document.getElementById('editOrderId').value;
  const address = buildAddressString(
    document.getElementById('editStreet').value,
    document.getElementById('editUnit').value,
    document.getElementById('editCity').value,
    document.getElementById('editPostalCode').value,
    document.getElementById('editCountry').value
  );

  try {
    const response = await fetch(`/api/delivery/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: document.getElementById('editCustomerName').value,
        address: address,
        phone: document.getElementById('editPhone').value,
        notes: document.getElementById('editNotes').value
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    closeModal('editOrderModal');
    showAlert('Order updated!', 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to update order: ' + error.message, 'error');
  }
}

async function deleteOrder(element, event, orderId) {
  // Support both direct call deleteOrder(id) and event delegation deleteOrder(el, ev, id)
  if (typeof element === 'string') {
    orderId = element;
  }
  if (!confirm('Are you sure you want to delete this order?')) return;

  try {
    const response = await fetch(`/api/delivery/orders/${orderId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    showAlert('Order deleted', 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to delete order: ' + error.message, 'error');
  }
}

async function generateRoute() {
  const btn = document.getElementById('generateRouteBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const response = await fetch('/api/delivery/route/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    const data = await response.json();
    showAlert(`Route generated with ${data.route.orders?.length || data.route.total_stops} stops!`, 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to generate route: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Today\'s Route';
  }
}

async function finishRoute() {
  if (!activeRoute) return;
  if (!confirm('Finish the route? Skipped orders will return to pending.')) return;

  try {
    const response = await fetch('/api/delivery/route/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeId: activeRoute.id })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    const data = await response.json();
    showAlert(`Route finished! ${data.result.completed} completed, ${data.result.rolledBack} returned to pending.`, 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to finish route: ' + error.message, 'error');
  }
}

async function geocodePending() {
  const btn = document.getElementById('geocodeBtn');
  btn.disabled = true;
  btn.textContent = 'Geocoding...';

  try {
    const response = await fetch('/api/delivery/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20 })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    const data = await response.json();
    showAlert(`Geocoding complete: ${data.result.success} success, ${data.result.failed} failed`, 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to geocode: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Geocode Pending Addresses';
  }
}

async function syncFromSquare() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  try {
    const response = await fetch('/api/delivery/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daysBack: 7 })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    const data = await response.json();
    showAlert(`Sync complete: Found ${data.found} orders, imported ${data.imported}, skipped ${data.skipped}`, 'success');
    loadOrders();
  } catch (error) {
    showAlert('Failed to sync: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync from Square';
  }
}

function showAlert(message, type) {
  const alertArea = document.getElementById('alertArea');
  // Escape message to prevent XSS; type is a controlled CSS class name
  alertArea.innerHTML = `<div class="alert ${type}">${escapeHtml(message)}</div>`;
  setTimeout(() => { alertArea.innerHTML = ''; }, 5000);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Expose functions to global scope for event delegation
window.showAddOrderModal = showAddOrderModal;
window.finishRoute = finishRoute;
window.generateRoute = generateRoute;
window.geocodePending = geocodePending;
window.syncFromSquare = syncFromSquare;
window.closeModal = closeModal;
window.editOrder = editOrder;
window.deleteOrder = deleteOrder;
window.submitAddOrder = submitAddOrder;
window.submitEditOrder = submitEditOrder;
