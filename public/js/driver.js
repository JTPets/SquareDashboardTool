/**
 * Driver Route page JavaScript
 * Externalized from driver.html for CSP compliance (P0-4 Phase 2)
 */

// Get token from URL
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');

// State
let route = null;
let stops = [];
let currentPodOrderId = null;
let currentPodFile = null;
let currentLocation = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  if (!token) {
    showError('No access token provided', 'Please use the link provided by the merchant.');
    return;
  }
  loadRoute();
});

async function loadRoute() {
  try {
    const response = await fetch(`/api/driver/${token}`);
    const data = await response.json();

    if (!response.ok) {
      showError(data.error || 'Failed to load route', 'This link may have expired or been revoked.');
      return;
    }

    route = data.route;
    stops = data.orders || [];

    renderRoute();
  } catch (error) {
    console.error('Error loading route:', error);
    showError('Failed to load route', 'Please check your internet connection and try again.');
  }
}

function showError(title, message) {
  document.getElementById('stopList').innerHTML = `
    <div class="error-state">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
  document.getElementById('finishSection').style.display = 'none';
}

function showSuccess(result) {
  document.querySelector('.header').style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
  document.getElementById('progressLabel').textContent = 'Route Complete!';
  document.getElementById('progressFill').style.width = '100%';
  document.getElementById('finishSection').style.display = 'none';

  document.getElementById('stopList').innerHTML = `
    <div class="success-state">
      <div class="icon">&#127881;</div>
      <h2>Route Completed!</h2>
      <p>Thank you for your deliveries today.</p>
      <div class="success-stats">
        <div><span>Completed:</span><strong>${result.completed}</strong></div>
        <div><span>Skipped:</span><strong>${result.skipped}</strong></div>
        <div><span>Total Stops:</span><strong>${route.totalStops}</strong></div>
      </div>
    </div>
  `;
}

function renderRoute() {
  // Update header
  document.getElementById('merchantName').textContent = route.merchantName;
  document.getElementById('routeTitle').textContent = `Route - ${formatDate(route.date)}`;

  // Update stats
  if (route.distanceKm || route.estimatedMinutes) {
    document.getElementById('routeStats').style.display = 'flex';
    document.getElementById('distanceDisplay').innerHTML = route.distanceKm
      ? `&#128205; ${route.distanceKm.toFixed(1)} km`
      : '';
    document.getElementById('durationDisplay').innerHTML = route.estimatedMinutes
      ? `&#9201; ~${route.estimatedMinutes} min`
      : '';
  }

  // Calculate progress
  const completed = stops.filter(s => s.status === 'completed' || s.status === 'delivered').length;
  const total = stops.length;
  const percent = total > 0 ? (completed / total * 100) : 0;

  document.getElementById('progressLabel').textContent = `${completed} of ${total} completed`;
  document.getElementById('progressCount').textContent = `${completed}/${total}`;
  document.getElementById('progressFill').style.width = `${percent}%`;

  // Show finish section if there are stops
  if (total > 0) {
    document.getElementById('finishSection').style.display = 'block';
  }

  // Render stops
  if (stops.length === 0) {
    document.getElementById('stopList').innerHTML = `
      <div class="empty-state">
        <h2>No Stops</h2>
        <p>This route has no deliveries.</p>
      </div>
    `;
    return;
  }

  // Find first non-completed stop
  const currentIndex = stops.findIndex(s => s.status === 'active');

  const html = stops.map((stop, index) => {
    const isCurrent = index === currentIndex;
    const isCompleted = stop.status === 'completed' || stop.status === 'delivered';
    const isSkipped = stop.status === 'skipped';

    let cardClass = 'stop-card';
    if (isCompleted) cardClass += ' completed';
    if (isCurrent) cardClass += ' current';
    if (isSkipped) cardClass += ' skipped';

    const statusClass = `status-${stop.status}`;
    const statusText = stop.status.charAt(0).toUpperCase() + stop.status.slice(1);

    // Build order items HTML
    let orderItemsHtml = '';
    if (stop.orderData?.lineItems && stop.orderData.lineItems.length > 0) {
      const itemCount = stop.orderData.lineItems.reduce((sum, item) => sum + parseInt(item.quantity || 1), 0);
      orderItemsHtml = `
        <div class="stop-order-items">
          <button class="order-items-toggle" data-action="toggleOrderItems">
            <span>&#128230; ${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
            <span class="toggle-arrow">&#9660;</span>
          </button>
          <div class="order-items-list">
            ${stop.orderData.lineItems.map(item => `
              <div class="order-item">
                <span class="item-qty">${item.quantity}x</span>
                <span class="item-name">${escapeHtml(item.name)}${item.variationName ? ` - ${escapeHtml(item.variationName)}` : ''}</span>
                ${item.modifiers && item.modifiers.length > 0 ? `
                  <div class="item-modifiers">
                    ${item.modifiers.map(m => `<span class="modifier">+ ${escapeHtml(m.name)}</span>`).join('')}
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    return `
      <div class="${cardClass}" data-id="${stop.id}">
        <div class="stop-header">
          <div class="stop-number">${stop.position || index + 1}</div>
          <div class="stop-customer">
            <h3>${escapeHtml(stop.customerName)}</h3>
          </div>
          <span class="stop-status ${statusClass}">${statusText}</span>
        </div>
        <div class="stop-body">
          <div class="stop-address" data-action="openMaps" data-action-param="${escapeHtml(stop.address)}">
            <span class="icon">&#128205;</span>
            <span class="text">${escapeHtml(stop.address)}</span>
            <span class="arrow">&#8594;</span>
          </div>

          ${stop.phone ? `
            <a href="tel:${stop.phone}" class="stop-phone">
              <span class="icon">&#128222;</span>
              <span>${escapeHtml(stop.phone)}</span>
            </a>
          ` : ''}

          ${stop.customerNote ? `
            <div class="stop-customer-notes">
              <strong>&#128221; Customer Info</strong>
              ${escapeHtml(stop.customerNote)}
            </div>
          ` : ''}

          ${stop.notes ? `
            <div class="stop-notes">
              <strong>&#128203; Order Notes</strong>
              ${escapeHtml(stop.notes)}
            </div>
          ` : ''}

          ${orderItemsHtml}

          ${stop.hasPod ? `
            <div class="stop-pod">
              <span>&#10003; POD captured</span>
            </div>
          ` : ''}

          ${!isCompleted && !isSkipped ? `
            <div class="stop-actions">
              <button class="btn btn-secondary" data-action="openPodModal" data-action-param="${stop.id}">
                &#128247; Photo
              </button>
              <button class="btn btn-warning" data-action="skipStop" data-action-param="${stop.id}">
                &#9197; Skip
              </button>
              <button class="btn btn-success" data-action="completeStop" data-action-param="${stop.id}">
                &#10003; Complete
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('stopList').innerHTML = html;
}

function toggleOrderItems(element, event, param) {
  // element is the button (from event delegation)
  const button = element;
  const list = button.nextElementSibling;
  const arrow = button.querySelector('.toggle-arrow');
  list.classList.toggle('visible');
  arrow.classList.toggle('open');
}

function openMaps(element, event, address) {
  // address comes from data-action-param via event delegation
  const encoded = encodeURIComponent(address);
  // Try to detect iOS vs Android
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    window.open(`maps://maps.apple.com/?q=${encoded}`, '_blank');
  } else {
    window.open(`https://www.google.com/maps/search/?api=1&query=${encoded}`, '_blank');
  }
}

async function completeStop(element, event, orderId) {
  // orderId comes from data-action-param via event delegation
  if (!confirm('Mark this delivery as complete?')) return;

  showLoading('Completing delivery...');
  try {
    const response = await fetch(`/api/driver/${token}/orders/${orderId}/complete`, {
      method: 'POST'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to complete');
    }

    showToast('Delivery completed!', 'success');
    await loadRoute();
  } catch (error) {
    console.error('Error:', error);
    showToast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

async function skipStop(element, event, orderId) {
  // orderId comes from data-action-param via event delegation
  if (!confirm('Skip this delivery? It will be returned to the queue.')) return;

  showLoading('Skipping...');
  try {
    const response = await fetch(`/api/driver/${token}/orders/${orderId}/skip`, {
      method: 'POST'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to skip');
    }

    showToast('Delivery skipped', 'success');
    await loadRoute();
  } catch (error) {
    console.error('Error:', error);
    showToast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

// POD Modal Functions
function openPodModal(element, event, orderId) {
  // orderId comes from data-action-param via event delegation
  currentPodOrderId = orderId;
  currentPodFile = null;
  document.getElementById('podPreview').classList.remove('visible');
  document.getElementById('uploadArea').style.display = 'block';
  document.getElementById('uploadPodBtn').disabled = true;
  document.getElementById('podFileInput').value = '';
  document.getElementById('podModal').classList.add('active');

  // Try to get location
  document.getElementById('locationStatus').textContent = 'Getting location...';
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        currentLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        document.getElementById('locationStatus').textContent = '&#128205; Location captured';
      },
      (error) => {
        currentLocation = null;
        document.getElementById('locationStatus').textContent = '&#9888; Location not available';
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  } else {
    document.getElementById('locationStatus').textContent = '&#9888; Location not supported';
  }
}

function closePodModal() {
  document.getElementById('podModal').classList.remove('active');
  currentPodOrderId = null;
  currentPodFile = null;
  currentLocation = null;
}

function handlePodFileSelect(element, event, param) {
  // element is the input, event is the change event (from event delegation)
  const file = element.files[0];
  if (!file) return;

  currentPodFile = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById('podPreview');
    preview.src = e.target.result;
    preview.classList.add('visible');
    document.getElementById('uploadArea').style.display = 'none';
    document.getElementById('uploadPodBtn').disabled = false;
  };
  reader.readAsDataURL(file);
}

async function uploadPod() {
  if (!currentPodFile || !currentPodOrderId) return;

  showLoading('Uploading photo...');
  closePodModal();

  try {
    const formData = new FormData();
    formData.append('photo', currentPodFile);
    if (currentLocation) {
      formData.append('latitude', currentLocation.latitude);
      formData.append('longitude', currentLocation.longitude);
    }

    const response = await fetch(`/api/driver/${token}/orders/${currentPodOrderId}/pod`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Upload failed');
    }

    showToast('Photo uploaded!', 'success');
    await loadRoute();
  } catch (error) {
    console.error('Error:', error);
    showToast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

async function finishRoute() {
  const completed = stops.filter(s => s.status === 'completed' || s.status === 'delivered').length;
  const pending = stops.filter(s => s.status === 'active').length;

  let confirmMsg = `Finish this route?\n\nCompleted: ${completed}\nPending: ${pending}`;
  if (pending > 0) {
    confirmMsg += '\n\nPending deliveries will be returned to the queue.';
  }

  if (!confirm(confirmMsg)) return;

  showLoading('Finishing route...');

  try {
    const driverName = document.getElementById('driverName').value.trim();
    const driverNotes = document.getElementById('driverNotes').value.trim();

    const response = await fetch(`/api/driver/${token}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverName, driverNotes })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to finish route');
    }

    showSuccess(data.result);
  } catch (error) {
    console.error('Error:', error);
    showToast(error.message, 'error');
  } finally {
    hideLoading();
  }
}

// Utility functions
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showLoading(text) {
  text = text || 'Loading...';
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('active');
}

function showToast(message, type) {
  type = type || '';
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast visible ' + type;
  setTimeout(() => { toast.classList.remove('visible'); }, 3000);
}

// Expose functions to global scope for event delegation
window.toggleOrderItems = toggleOrderItems;
window.openMaps = openMaps;
window.completeStop = completeStop;
window.skipStop = skipStop;
window.openPodModal = openPodModal;
window.closePodModal = closePodModal;
window.uploadPod = uploadPod;
window.finishRoute = finishRoute;
window.handlePodFileSelect = handlePodFileSelect;
