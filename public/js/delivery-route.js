/**
 * Delivery Route page JavaScript
 * Externalized from delivery-route.html for CSP compliance (P0-4 Phase 2)
 */

// State
let route = null;
let stops = [];
let currentPodOrderId = null;
let podFile = null;
let currentNoteOrderId = null;
let currentShareToken = null;

// Refresh interval reference
let refreshInterval = null;

async function loadRoute() {
  try {
    const response = await fetch('/api/delivery/route/active');

    // Handle auth/session errors
    if (response.status === 401 || response.status === 403) {
      showEmptyState('Session expired. <a href="/login.html">Login again</a>');
      return;
    }

    if (!response.ok) throw new Error('Failed to load route');

    const data = await response.json();

    if (!data.route) {
      showEmptyState();
      return;
    }

    route = data.route;
    stops = data.orders || [];

    // Debug: Log order data to help diagnose rendering issues
    console.log('Route loaded:', route?.id);
    console.log('Orders loaded:', stops.length);
    stops.forEach((stop, i) => {
      const items = stop.square_order_data?.lineItems || [];
      console.log(`Order ${i + 1} (${stop.customer_name}):`, {
        id: stop.id,
        hasSquareCustomerId: !!stop.square_customer_id,
        hasSquareOrderData: !!stop.square_order_data,
        lineItemsCount: items.length,
        lineItems: items.map(item => ({
          name: item.name,
          quantity: item.quantity,
          variationName: item.variationName
        })),
        totalMoney: stop.square_order_data?.totalMoney
      });
    });

    renderRoute();
  } catch (error) {
    console.error('Error loading route:', error);
    // Only show error state if we don't have existing data
    // This prevents flickering on temporary network issues
    if (!route) {
      showEmptyState('Unable to load route. Check connection.');
    } else {
      showToast('Connection issue. Data may be stale.', 'error');
    }
  }
}

function showEmptyState(message) {
  message = message || 'No Active Route';
  document.getElementById('stopList').innerHTML = `
    <div class="empty-state">
      <h2>${message}</h2>
      <p>Go to <a href="/delivery.html">Delivery Queue</a> to generate a route.</p>
    </div>
  `;
  document.getElementById('progressLabel').textContent = 'No route';
  document.getElementById('progressCount').textContent = '';
}

function renderRoute() {
  // Update header
  document.getElementById('routeTitle').textContent = `Route - ${route.route_date || 'Today'}`;

  // Calculate progress
  const completed = stops.filter(s => s.status === 'completed').length;
  const total = stops.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  document.getElementById('progressLabel').textContent = completed === total ? 'Route Complete!' : 'In Progress';
  document.getElementById('progressCount').textContent = `${completed}/${total}`;
  document.getElementById('progressFill').style.width = percent + '%';

  // Show route stats
  if (route.total_distance_km || route.estimated_duration_min) {
    document.getElementById('routeStats').style.display = 'flex';
    document.getElementById('distanceDisplay').textContent = route.total_distance_km
      ? `${route.total_distance_km.toFixed(1)} km`
      : '';
    document.getElementById('durationDisplay').textContent = route.estimated_duration_min
      ? `~${route.estimated_duration_min} min`
      : '';
  }

  // Find current stop (first non-completed)
  const currentIndex = stops.findIndex(s => s.status !== 'completed');

  // Render stops
  document.getElementById('stopList').innerHTML = stops.map((stop, index) => {
    try {
      const isCurrent = index === currentIndex;
      const isCompleted = stop.status === 'completed';
      const isSkipped = stop.status === 'skipped';

      return `
      <div class="stop-card ${isCompleted ? 'completed' : ''} ${isCurrent ? 'current' : ''} ${isSkipped ? 'skipped' : ''}">
        <div class="stop-header">
          <div class="stop-number">${isCompleted ? '&#10003;' : stop.route_position || index + 1}</div>
          <div class="stop-customer">
            <h3>${escapeHtml(stop.customer_name)}</h3>
            <div class="customer-badges" id="badges-${stop.id}">
              ${(stop.square_customer_id || stop.phone) ? '<span class="badge badge-loading">Loading...</span>' : ''}
            </div>
          </div>
          <span class="stop-status status-${stop.status}">${stop.status}</span>
        </div>
        <div class="stop-body">
          <div class="stop-address" data-action="openInMaps" data-action-param="${escapeHtml(stop.address)}">
            <span class="icon">&#128205;</span>
            <span class="text">${escapeHtml(stop.address)}</span>
            <span class="arrow">&#8250;</span>
          </div>

          ${stop.phone ? `
            <a href="tel:${stop.phone}" class="stop-phone">
              <span class="icon">&#128222;</span>
              <span>${escapeHtml(stop.phone)}</span>
            </a>
          ` : ''}

          ${stop.customer_note ? `
            <div class="stop-customer-notes">
              <button class="edit-btn" data-action="editCustomerNote" data-action-param="${escapeHtml(stop.id)}" data-note="${escapeHtml(stop.customer_note || '')}">Edit</button>
              <strong>&#127968; Customer Info:</strong>
              ${escapeHtml(stop.customer_note)}
            </div>
          ` : (stop.square_customer_id ? `
            <div class="stop-customer-notes" style="opacity: 0.7;">
              <button class="edit-btn" data-action="editCustomerNote" data-action-param="${escapeHtml(stop.id)}" data-note="">+ Add</button>
              <strong>&#127968; Customer Info:</strong>
              <em>No notes saved for this customer</em>
            </div>
          ` : '')}

          ${stop.notes ? `
            <div class="stop-notes">
              <strong>&#128221; Order Notes:</strong>
              ${escapeHtml(stop.notes)}
            </div>
          ` : ''}

          ${stop.square_order_data && stop.square_order_data.lineItems && stop.square_order_data.lineItems.length > 0 ? `
            <div class="stop-order-items">
              <button class="order-items-toggle" data-action="toggleOrderItems" data-action-param="${escapeHtml(stop.id)}">
                &#128230; View Order Items (${stop.square_order_data.lineItems.length})
                <span class="toggle-arrow" id="arrow-${stop.id}">&#9660;</span>
              </button>
              <div class="order-items-list" id="items-${stop.id}" style="display: none;">
                ${renderLineItems(stop.square_order_data.lineItems, stop.id)}
                ${stop.square_order_data.totalMoney ? `
                  <div class="order-total">
                    <strong>Total:</strong> $${(Number(stop.square_order_data.totalMoney.amount) / 100).toFixed(2)}
                  </div>
                ` : ''}
              </div>
            </div>
          ` : ''}

          ${stop.pod_photo_path ? `
            <div class="stop-pod">
              <span>&#10003; POD captured</span>
              <span>${formatTime(stop.pod_captured_at)}</span>
            </div>
          ` : ''}

          ${!isCompleted ? `
            <div class="stop-actions">
              ${!stop.pod_photo_path ? `
                <button class="btn btn-primary" data-action="openPodModal" data-action-param="${escapeHtml(stop.id)}">
                  &#128247; Photo
                </button>
              ` : ''}
              <button class="btn btn-success" data-action="completeStop" data-action-param="${escapeHtml(stop.id)}">
                &#10003; Complete
              </button>
              ${stop.status !== 'skipped' ? `
                <button class="btn btn-warning" data-action="skipStop" data-action-param="${escapeHtml(stop.id)}">
                  Skip
                </button>
              ` : ''}
            </div>
          ` : ''}
        </div>
      </div>
    `;
    } catch (renderError) {
      console.error(`Error rendering stop ${index + 1} (${stop?.customer_name || 'unknown'}):`, renderError);
      return `
      <div class="stop-card" style="border: 2px solid #ef4444;">
        <div class="stop-header">
          <div class="stop-number" style="background: #ef4444;">${index + 1}</div>
          <div class="stop-customer">
            <h3>${escapeHtml(stop?.customer_name || 'Unknown Customer')}</h3>
            <div class="customer-badges">
              <span class="badge badge-unpaid">Render Error</span>
            </div>
          </div>
        </div>
        <div class="stop-body">
          <p style="color: #ef4444;">Error displaying this stop. Check console for details.</p>
          ${stop?.address ? `<div class="stop-address" data-action="openInMaps" data-action-param="${escapeHtml(stop.address)}">
            <span class="icon">&#128205;</span>
            <span class="text">${escapeHtml(stop.address)}</span>
          </div>` : ''}
        </div>
      </div>
    `;
    }
  }).join('');

  // Fetch customer stats for all stops with Square customer IDs
  fetchAllCustomerStats();
}

async function fetchAllCustomerStats() {
  // Get all stops with customer IDs OR phone numbers (backend can look up by phone)
  const stopsWithCustomers = stops.filter(s => s.square_customer_id || s.phone);

  // Fetch in batches of 5 to avoid overwhelming the server
  const batchSize = 5;
  for (let i = 0; i < stopsWithCustomers.length; i += batchSize) {
    const batch = stopsWithCustomers.slice(i, i + batchSize);
    await Promise.all(batch.map(stop => fetchCustomerStats(stop.id)));
  }
}

async function fetchCustomerStats(orderId) {
  const badgeContainer = document.getElementById(`badges-${orderId}`);
  try {
    const response = await fetch(`/api/delivery/orders/${orderId}/customer-stats`);
    if (!response.ok) {
      // Clear loading badge on non-OK response
      if (badgeContainer) badgeContainer.innerHTML = '';
      return;
    }

    const stats = await response.json();
    updateBadges(orderId, stats);
  } catch (error) {
    console.error('Error fetching customer stats:', error);
    // Remove loading badge on error
    if (badgeContainer) {
      badgeContainer.innerHTML = '';
    }
  }
}

function updateBadges(orderId, stats) {
  const badgeContainer = document.getElementById(`badges-${orderId}`);
  if (!badgeContainer) return;

  const badges = [];

  // Repeat customer badge
  if (stats.is_repeat_customer && stats.order_count > 1) {
    badges.push(`<span class="badge badge-repeat">&#128260; ${stats.order_count} orders</span>`);
  }

  // Loyalty member badge
  if (stats.is_loyalty_member) {
    const balanceText = stats.loyalty_balance !== null ? ` (${stats.loyalty_balance} pts)` : '';
    badges.push(`<span class="badge badge-loyalty">&#11088; VIP${balanceText}</span>`);
  }

  // Payment status badge
  if (stats.payment_status === 'paid') {
    badges.push(`<span class="badge badge-paid">&#128176; PAID</span>`);
  } else if (stats.payment_status === 'unpaid') {
    badges.push(`<span class="badge badge-unpaid">&#128179; COD</span>`);
  } else if (stats.payment_status === 'partial') {
    badges.push(`<span class="badge badge-partial">&#128179; Partial</span>`);
  }

  badgeContainer.innerHTML = badges.join('');
}

function openInMaps(element, event, param) {
  const address = param;

  // Try to detect platform and open in native maps
  const encodedAddress = encodeURIComponent(address);

  // Check if iOS
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    // Try Apple Maps first, fall back to Google Maps
    window.location.href = `maps://maps.apple.com/?q=${encodedAddress}`;
  } else if (/Android/.test(navigator.userAgent)) {
    // Android - use geo: URI to trigger system app chooser (Waze, Google Maps, etc.)
    window.location.href = `geo:0,0?q=${encodedAddress}`;
  } else {
    // Desktop/others - open Google Maps in new tab
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodedAddress}`, '_blank');
  }
}

function toggleOrderItems(element, event, param) {
  const orderId = param;
  const itemsList = document.getElementById(`items-${orderId}`);
  const arrow = document.getElementById(`arrow-${orderId}`);
  if (itemsList && arrow) {
    const isHidden = itemsList.style.display === 'none';
    itemsList.style.display = isHidden ? 'block' : 'none';
    arrow.classList.toggle('open', isHidden);
  }
}

function openPodModal(element, event, param) {
  const orderId = param;
  currentPodOrderId = orderId;
  podFile = null;
  document.getElementById('podPreview').classList.remove('visible');
  document.getElementById('uploadArea').style.display = 'block';
  document.getElementById('podModalFooter').style.display = 'none';
  document.getElementById('podFileInput').value = '';
  document.getElementById('podModal').classList.add('active');
}

function closePodModal() {
  document.getElementById('podModal').classList.remove('active');
  currentPodOrderId = null;
  podFile = null;
}

function resetPodModal() {
  podFile = null;
  document.getElementById('podPreview').classList.remove('visible');
  document.getElementById('uploadArea').style.display = 'block';
  document.getElementById('podModalFooter').style.display = 'none';
  document.getElementById('podFileInput').value = '';
}

function handlePodSelect(element, event, param) {
  const file = element.files ? element.files[0] : null;
  if (!file) return;

  podFile = file;

  // Show preview
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('podPreview').src = e.target.result;
    document.getElementById('podPreview').classList.add('visible');
    document.getElementById('uploadArea').style.display = 'none';
    document.getElementById('podModalFooter').style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

async function uploadPod() {
  if (!podFile || !currentPodOrderId) return;

  showLoading(true);

  try {
    const formData = new FormData();
    formData.append('photo', podFile);

    // Try to get GPS location
    if (navigator.geolocation) {
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
        });
        formData.append('latitude', position.coords.latitude);
        formData.append('longitude', position.coords.longitude);
      } catch (gpsError) {
        console.log('GPS not available:', gpsError);
      }
    }

    const response = await fetch(`/api/delivery/orders/${currentPodOrderId}/pod`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    closePodModal();
    showToast('Photo saved!', 'success');
    loadRoute();
  } catch (error) {
    showToast('Failed to upload photo: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function completeStop(element, event, param) {
  const orderId = param;
  if (!confirm('Mark this delivery as complete?')) return;

  showLoading(true);

  try {
    const response = await fetch(`/api/delivery/orders/${orderId}/complete`, {
      method: 'POST'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    const result = await response.json();

    // Show appropriate toast based on Square sync status
    if (result.square_synced) {
      showToast('Delivery completed & synced to Square!', 'success');
    } else if (result.square_sync_error) {
      showToast('Completed locally. Square sync failed: ' + result.square_sync_error, 'error');
    } else {
      showToast('Delivery completed!', 'success');
    }

    loadRoute();
  } catch (error) {
    showToast('Failed to complete: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function skipStop(element, event, param) {
  const orderId = param;
  if (!confirm('Skip this stop? It will return to the queue for tomorrow.')) return;

  showLoading(true);

  try {
    const response = await fetch(`/api/delivery/orders/${orderId}/skip`, {
      method: 'POST'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    showToast('Stop skipped', 'success');
    loadRoute();
  } catch (error) {
    showToast('Failed to skip: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

function editCustomerNote(element, event, param) {
  const orderId = param;
  const currentNote = element.dataset.note || '';
  currentNoteOrderId = orderId;
  document.getElementById('customerNoteInput').value = currentNote || '';
  document.getElementById('noteModal').classList.add('active');
}

function closeNoteModal() {
  document.getElementById('noteModal').classList.remove('active');
  currentNoteOrderId = null;
}

async function saveCustomerNote() {
  if (!currentNoteOrderId) return;

  const note = document.getElementById('customerNoteInput').value.trim();
  showLoading(true);

  try {
    const response = await fetch(`/api/delivery/orders/${currentNoteOrderId}/customer-note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }

    const result = await response.json();

    closeNoteModal();

    if (result.square_synced) {
      showToast('Customer info saved to Square!', 'success');
    } else {
      showToast('Customer info saved locally', 'success');
    }

    loadRoute();
  } catch (error) {
    showToast('Failed to save: ' + error.message, 'error');
  } finally {
    showLoading(false);
  }
}

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('active', show);
}

function showToast(message, type) {
  type = type || '';
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast visible ' + type;
  setTimeout(() => { toast.classList.remove('visible'); }, 3000);
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Render line items with error handling for each item
function renderLineItems(lineItems, orderId) {
  // Debug: log what we're rendering
  console.log(`renderLineItems for order ${orderId}:`, lineItems);

  if (!lineItems || !Array.isArray(lineItems)) {
    console.error(`Order ${orderId}: lineItems is not an array:`, lineItems);
    return '<div class="order-item" style="color: #ef4444;">Error: Invalid items data</div>';
  }

  if (lineItems.length === 0) {
    console.warn(`Order ${orderId}: lineItems array is empty`);
    return '<div class="order-item" style="color: #f59e0b;">No items in this order</div>';
  }

  const result = lineItems.map((item, idx) => {
    try {
      // Debug log for each item
      if (!item.name) {
        console.warn(`Order ${orderId} item ${idx}: missing name`, item);
      }

      const qty = item.quantity || '?';
      const name = escapeHtml(item.name || 'Unknown Item');
      const variation = item.variationName ? ` (${escapeHtml(item.variationName)})` : '';
      const gtin = item.gtin ? `<span class="item-gtin">[${escapeHtml(item.gtin)}]</span>` : '';

      let modifiersHtml = '';
      if (item.modifiers && Array.isArray(item.modifiers) && item.modifiers.length > 0) {
        modifiersHtml = `
          <div class="item-modifiers">
            ${item.modifiers.map(m => `<span class="modifier">+ ${escapeHtml(m?.name || 'Unknown')}</span>`).join('')}
          </div>
        `;
      }

      const noteHtml = item.note ? `<div class="item-note">&#128221; ${escapeHtml(item.note)}</div>` : '';

      return `
        <div class="order-item">
          <span class="item-qty">${qty}x</span>
          <span class="item-name">${name}${variation}</span>
          ${gtin}
          ${modifiersHtml}
          ${noteHtml}
        </div>
      `;
    } catch (itemError) {
      console.error(`Order ${orderId} item ${idx} render error:`, itemError, item);
      return `<div class="order-item" style="color: #ef4444;">Error rendering item ${idx + 1}</div>`;
    }
  }).join('');

  console.log(`renderLineItems result for ${orderId}: ${result.length} chars`);
  return result;
}

// Share Route Functions
async function openShareModal() {
  if (!route) {
    showToast('No active route to share', 'error');
    return;
  }

  document.getElementById('shareModal').classList.add('active');

  // Check if there's an existing token
  try {
    const response = await fetch(`/api/delivery/route/${route.id}/token`);
    const data = await response.json();

    if (data.token) {
      currentShareToken = data.token;
      showExistingShareToken(data.shareUrl, data.token.expires_at);
    } else {
      showNoShareToken();
    }
  } catch (error) {
    console.error('Error checking share token:', error);
    showNoShareToken();
  }
}

function closeShareModal() {
  document.getElementById('shareModal').classList.remove('active');
}

function showNoShareToken() {
  document.getElementById('noShareToken').style.display = 'block';
  document.getElementById('hasShareToken').style.display = 'none';
  document.getElementById('revokeBtn').style.display = 'none';
  currentShareToken = null;
}

function showExistingShareToken(shareUrl, expiresAt) {
  document.getElementById('noShareToken').style.display = 'none';
  document.getElementById('hasShareToken').style.display = 'block';
  document.getElementById('revokeBtn').style.display = 'block';
  document.getElementById('shareUrlInput').value = shareUrl;
  document.getElementById('shareExpiry').textContent = new Date(expiresAt).toLocaleString();
}

async function generateShareLink() {
  if (!route) return;

  showLoading(true);
  try {
    const response = await fetch(`/api/delivery/route/${route.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInHours: 24 })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to generate link');
    }

    const data = await response.json();
    currentShareToken = data.token;
    showExistingShareToken(data.shareUrl, data.expiresAt);
    showToast('Share link generated!', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function regenerateShareLink() {
  if (!confirm('Generate a new link? This will invalidate the previous one.')) return;
  await generateShareLink();
}

async function copyShareUrl() {
  const input = document.getElementById('shareUrlInput');
  try {
    await navigator.clipboard.writeText(input.value);
    showToast('Link copied!', 'success');
  } catch (err) {
    // Fallback for older browsers
    input.select();
    document.execCommand('copy');
    showToast('Link copied!', 'success');
  }
}

async function revokeShareLink() {
  if (!confirm('Revoke this share link? The driver will lose access immediately.')) return;
  if (!route) return;

  showLoading(true);
  try {
    const response = await fetch(`/api/delivery/route/${route.id}/token`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to revoke');
    }

    showNoShareToken();
    showToast('Share link revoked', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    showLoading(false);
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function() {
  // Initial load
  loadRoute();

  // Refresh every 60 seconds (only when page is visible)
  refreshInterval = setInterval(loadRoute, 60000);
});

// Handle screen unlock / tab visibility changes
document.addEventListener('visibilitychange', async function() {
  if (document.visibilityState === 'visible') {
    // Page became visible (e.g., screen unlocked, tab switched back)
    // Reload the route data silently
    try {
      await loadRoute();
    } catch (error) {
      // If session expired or network error, show friendly message
      console.error('Failed to reload route on visibility change:', error);
      showToast('Connection issue. Pull down to refresh.', 'error');
    }
  }
});

// Also handle page focus (belt and suspenders)
window.addEventListener('focus', function() {
  // Debounce - don't reload if we just loaded
  if (route) {
    loadRoute().catch(err => {
      console.error('Failed to reload on focus:', err);
    });
  }
});

// Expose functions to global scope for event delegation
window.openShareModal = openShareModal;
window.openInMaps = openInMaps;
window.toggleOrderItems = toggleOrderItems;
window.editCustomerNote = editCustomerNote;
window.openPodModal = openPodModal;
window.completeStop = completeStop;
window.skipStop = skipStop;
window.closePodModal = closePodModal;
window.resetPodModal = resetPodModal;
window.uploadPod = uploadPod;
window.closeNoteModal = closeNoteModal;
window.saveCustomerNote = saveCustomerNote;
window.closeShareModal = closeShareModal;
window.generateShareLink = generateShareLink;
window.copyShareUrl = copyShareUrl;
window.regenerateShareLink = regenerateShareLink;
window.revokeShareLink = revokeShareLink;
window.handlePodSelect = handlePodSelect;
