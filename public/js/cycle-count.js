/**
 * Cycle Count page JavaScript
 * Externalized from cycle-count.html for CSP compliance (P0-4 Phase 2)
 */

// State
let pendingItems = [];
let countedToday = 0;
let target = 0;
let lastLoadTime = 0;

// Count modal state
let currentCountItem = null;
let currentCountIndex = null;
let systemCount = 0;

// Calculate and display completion status
function updateCompletionDisplay(pending, dailyTarget) {
  const el = document.getElementById('completion-rate');
  if (dailyTarget <= 0) {
    el.textContent = '0%';
    return;
  }

  if (pending <= dailyTarget) {
    // Normal case: show completion percentage
    const completed = dailyTarget - pending;
    const pct = Math.round((completed / dailyTarget) * 100);
    el.textContent = `${pct}%`;
  } else {
    // Behind: show days behind instead of negative percentage
    const daysBehind = Math.ceil(pending / dailyTarget) - 1;
    if (daysBehind === 1) {
      el.textContent = '1 day behind';
    } else {
      el.textContent = `${daysBehind} days behind`;
    }
  }
}

// Load pending items on page load
async function loadPendingItems(element, event, preserveScroll) {
  // Support both direct call and event delegation
  if (typeof element === 'boolean') {
    preserveScroll = element;
  } else if (typeof element === 'object' && element !== null) {
    // Called via event delegation - preserveScroll defaults to false
    preserveScroll = false;
  }

  const container = document.getElementById('items-container');
  const scrollPosition = preserveScroll ? window.scrollY : 0;

  // Only show loading spinner if not preserving scroll (initial load)
  if (!preserveScroll) {
    container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading cycle count items...</p></div>';
  }

  try {
    const response = await fetch('/api/cycle-counts/pending');
    const data = await response.json();

    pendingItems = data.items || [];
    target = data.target || 0;

    // Debug: Check for items without IDs
    const itemsWithoutIds = pendingItems.filter(item => !item.id || item.id === 'null');
    if (itemsWithoutIds.length > 0) {
      console.error('Found items without valid IDs:', itemsWithoutIds);
      showToast(`Warning: ${itemsWithoutIds.length} items have invalid IDs and will be hidden`, 'error');
    }

    // Update stats
    document.getElementById('pending-count').textContent = pendingItems.length;
    document.getElementById('target-count').textContent = target;

    // Calculate completion
    const completed = Math.max(0, target - pendingItems.length);
    countedToday = completed;
    updateCompletionDisplay(pendingItems.length, target);

    if (pendingItems.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">&#10003;</div>
          <h3>All Done!</h3>
          <p>No items to count right now.</p>
          <p>Great job completing today's cycle count!</p>
        </div>
      `;
      return;
    }

    renderItems();

    // Restore scroll position if preserving
    if (preserveScroll && scrollPosition > 0) {
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollPosition);
      });
    }

    lastLoadTime = Date.now();

  } catch (error) {
    console.error('Failed to load items:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#9888;</div>
        <h3>Error Loading Items</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}

function renderItems() {
  const container = document.getElementById('items-container');

  container.innerHTML = pendingItems
    .filter(item => item.id && item.id !== 'null') // Filter out items without valid IDs
    .map((item, index) => {
    const imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    const imageHtml = imageUrl
      ? `<img src="${escapeAttr(imageUrl)}" class="item-image cycle-count-image" alt="Product">
         <div class="no-image" style="display:none;">&#128230;</div>`
      : `<div class="no-image">&#128230;</div>`;

    // LOGIC CHANGE: using shared formatCurrency (BACKLOG-23)
    const price = item.price_money ? `${item.currency || 'CAD'} ${formatCurrency(item.price_money)}` : 'N/A';

    return `
      <div class="item-card ${item.is_priority ? 'priority' : ''}" id="item-${escapeHtml(item.id)}">
        <div class="item-header">
          <div class="item-image-container">
            ${imageHtml}
          </div>
          <div class="item-info">
            <div class="item-name">${escapeHtml(item.item_name)}</div>
            ${item.variation_name ? `<div class="item-variation">${escapeHtml(item.variation_name)}</div>` : ''}

            <div class="item-details">
              <div class="detail-item">
                <span class="detail-label">SKU</span>
                <span class="detail-value">${escapeHtml(item.sku || 'N/A')}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">UPC</span>
                <span class="detail-value">${escapeHtml(item.upc || 'N/A')}</span>
              </div>
            </div>

            <div class="item-meta">
              <span class="badge badge-price">${price}</span>
              ${item.category_name ? `<span class="badge badge-category">${escapeHtml(item.category_name)}</span>` : ''}
              ${item.is_priority ? '<span class="badge badge-priority">&#9889; Priority</span>' : ''}
              <span class="badge badge-inventory">&#128230; ${item.current_inventory} on hand</span>
              ${item.committed_quantity > 0 ? `<span class="badge badge-committed">${item.available_quantity} avail / ${item.committed_quantity} committed</span>` : ''}
              ${getLastCountedBadge(item)}
            </div>
          </div>
        </div>
        <div class="item-actions">
          <button class="mark-counted-btn" data-action="showCountModal" data-action-param="${escapeHtml(item.id)}">
            &#10003; Mark as Counted
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function showCountModal(element, event, itemId) {
  // Support both direct call and event delegation
  if (typeof element === 'string') {
    itemId = element;
  }
  // Validate item ID
  if (!itemId || itemId === 'null' || itemId === 'undefined') {
    console.error('Invalid item ID:', itemId);
    showToast('Invalid item ID. Please refresh the page.', 'error');
    return;
  }

  // Find item by ID (not by index, since filtering may have changed indices)
  const item = pendingItems.find(i => i.id === itemId);
  if (!item) {
    console.error('Item not found with ID:', itemId);
    showToast('Item not found. Please refresh the page.', 'error');
    return;
  }

  currentCountItem = itemId;
  currentCountIndex = null; // We'll look up by ID instead
  systemCount = Number(item.current_inventory) || 0;  // Ensure it's a number

  // Set system count
  document.getElementById('modal-system-count').textContent = systemCount;

  // Show committed quantity breakdown if any
  const committedInfo = document.getElementById('modal-committed-info');
  const committed = Number(item.committed_quantity) || 0;
  const available = Number(item.available_quantity) || 0;
  if (committed > 0) {
    committedInfo.innerHTML = `<span style="color: #92400e;">&#9888; ${escapeHtml(String(available))} available + ${escapeHtml(String(committed))} committed (in invoices/orders)</span>
      <br><span style="color: #dc2626; font-weight: 500;">Confirm with management before adjusting committed inventory</span>`;
  } else {
    committedInfo.textContent = '';
  }

  // Reset form
  document.getElementById('actual-count').value = '';
  document.getElementById('count-notes').value = '';
  document.getElementById('actual-count').focus();

  // Show modal
  document.getElementById('count-modal').classList.add('active');
}

function closeCountModal() {
  document.getElementById('count-modal').classList.remove('active');
  currentCountItem = null;
  currentCountIndex = null;
  systemCount = 0;
}

async function submitCount() {
  if (currentCountItem === null) {
    showToast('Invalid item. Please try again.', 'error');
    return;
  }

  // Get the actual count from the input
  const actualCountInput = document.getElementById('actual-count').value;
  if (actualCountInput === '' || actualCountInput === null) {
    showToast('Please enter the actual physical count', 'error');
    return;
  }

  const actualQty = parseInt(actualCountInput);
  if (isNaN(actualQty) || actualQty < 0) {
    showToast('Please enter a valid count (0 or greater)', 'error');
    return;
  }

  // Find item by ID (not by index)
  const item = pendingItems.find(i => i.id === currentCountItem);
  if (!item) {
    showToast('Item not found. Please refresh the page.', 'error');
    return;
  }

  // Store values BEFORE closing modal (which resets them)
  const itemId = currentCountItem;
  const expectedQty = Number(systemCount);  // Ensure it's a number for accurate comparison
  const notes = document.getElementById('count-notes').value.trim() || null;

  // Automatically determine if the count is accurate (has variance)
  const isAccurate = (actualQty === expectedQty);
  const hasVariance = !isAccurate;

  // Close modal (this resets currentCountItem, systemCount to null/0)
  closeCountModal();

  // Find and disable button (use stored itemId, not currentCountItem which is now null)
  const btn = document.querySelector(`#item-${itemId} .mark-counted-btn`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = hasVariance ? '&#8987; Syncing to Square...' : '&#8987; Marking...';
  }

  try {
    // Step 1: Record the count locally
    const response = await fetch(`/api/cycle-counts/${itemId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        counted_by: 'Mobile User',
        is_accurate: isAccurate,
        actual_quantity: actualQty,
        expected_quantity: expectedQty,
        notes: notes
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => null);
      const errMsg = errData?.error || errData?.details?.map(d => d.message).join(', ') || 'Failed to mark item as counted';
      throw new Error(errMsg);
    }

    const result = await response.json();

    // Step 2: If there's a variance, automatically push update to Square
    let syncResult = null;
    let syncError = null;

    if (hasVariance) {
      if (btn) btn.textContent = '&#8987; Pushing to Square...';

      try {
        const syncResponse = await fetch(`/api/cycle-counts/${itemId}/sync-to-square`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actual_quantity: actualQty
          })
        });

        const syncData = await syncResponse.json();

        if (!syncResponse.ok) {
          // Handle specific error cases
          if (syncResponse.status === 409 && syncData.action_required === 'sync_inventory') {
            syncError = {
              type: 'inventory_mismatch',
              message: syncData.error,
              details: syncData.details
            };
          } else {
            syncError = {
              type: 'general',
              message: syncData.error || 'Failed to sync to Square'
            };
          }
        } else {
          syncResult = syncData.data;
        }
      } catch (err) {
        syncError = {
          type: 'network',
          message: 'Network error syncing to Square: ' + err.message
        };
      }
    }

    // Visual feedback
    const card = document.getElementById(`item-${itemId}`);
    card.classList.add('counted');
    if (btn) {
      btn.classList.add('counted');
      if (hasVariance && syncResult) {
        btn.textContent = '&#10003; Synced to Square';
      } else if (hasVariance && syncError) {
        btn.textContent = '&#9888; Counted (Sync Failed)';
      } else {
        btn.textContent = '&#10003; Counted';
      }
    }

    // Remove from pending list (find by ID)
    const itemIndex = pendingItems.findIndex(i => i.id === itemId);
    if (itemIndex !== -1) {
      pendingItems.splice(itemIndex, 1);
    }

    // Update stats
    countedToday++;
    const remaining = pendingItems.length;
    document.getElementById('pending-count').textContent = remaining;
    updateCompletionDisplay(remaining, target);

    // Show appropriate success/error message
    if (syncError) {
      if (syncError.type === 'inventory_mismatch') {
        showToast(`Count recorded, but Square sync failed: Inventory changed. Please sync inventory first. (Square: ${syncError.details?.square_quantity}, DB: ${syncError.details?.database_quantity})`, 'error');
      } else {
        showToast(`Count recorded, but Square sync failed: ${syncError.message}`, 'error');
      }
    } else if (syncResult) {
      const variance = syncResult.variance !== 0 ? ` (${syncResult.variance > 0 ? '+' : ''}${syncResult.variance})` : '';
      showToast(`Synced to Square! ${syncResult.previous_quantity} -> ${syncResult.new_quantity}${variance}`, 'success');
    } else if (result.data?.is_complete) {
      showToast('&#10003; Item counted! 100% COMPLETE - Report being sent!', 'success');
    } else {
      showToast(`Count verified! ${remaining} items remaining`, 'success');
    }

    // Remove card after animation
    setTimeout(() => {
      card.style.display = 'none';

      // Check if all done
      if (remaining === 0) {
        setTimeout(() => {
          loadPendingItems();
        }, 500);
      }
    }, 1000);

  } catch (error) {
    console.error('Failed to mark counted:', error);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '&#10003; Mark as Counted';
    }
    showToast('Failed to mark item: ' + error.message, 'error');
  }
}

function showSendNowModal() {
  document.getElementById('send-now-modal').classList.add('active');
  document.getElementById('sku-input').focus();
}

function closeSendNowModal() {
  document.getElementById('send-now-modal').classList.remove('active');
  document.getElementById('sku-input').value = '';
}

async function submitSendNow() {
  const skuInput = document.getElementById('sku-input').value.trim();
  if (!skuInput) {
    showToast('Please enter at least one SKU', 'error');
    return;
  }

  const skus = skuInput.split('\n').map(s => s.trim()).filter(s => s);

  try {
    const response = await fetch('/api/cycle-counts/send-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus, added_by: 'Mobile User' })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to add priority items');
    }

    const result = await response.json();
    showToast(`Added ${result.items_added} items to priority queue!`, 'success');
    closeSendNowModal();

    // Reload items after short delay
    setTimeout(() => loadPendingItems(), 1000);

  } catch (error) {
    console.error('Send now failed:', error);
    showToast('Error: ' + error.message, 'error');
  }
}

async function generateBatch() {
  const btn = document.getElementById('generate-batch-btn');
  btn.disabled = true;
  btn.textContent = '&#9889; Generating...';

  try {
    const response = await fetch('/api/cycle-counts/generate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate batch');
    }

    const result = await response.json();
    const recountMsg = result.yesterday_inaccurate_added > 0
      ? ` + ${result.yesterday_inaccurate_added} recount${result.yesterday_inaccurate_added > 1 ? 's' : ''}`
      : '';
    showToast(`Batch generated! Added ${result.new_items_added} new items${recountMsg}. Total: ${result.total_in_batch}`, 'success');

    // Reload items after short delay
    setTimeout(() => loadPendingItems(), 1000);

  } catch (error) {
    console.error('Generate batch failed:', error);
    showToast('Error: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '&#9889; Generate Batch';
  }
}

function getLastCountedBadge(item) {
  if (!item.last_counted_date) {
    return '<span class="badge" style="background: #fef3c7; color: #92400e;">&#128203; Never Counted</span>';
  }

  const lastCounted = new Date(item.last_counted_date);
  const now = new Date();
  const daysSince = Math.floor((now - lastCounted) / (1000 * 60 * 60 * 24));

  if (daysSince === 0) {
    return '<span class="badge" style="background: #dcfce7; color: #166534;">&#10003; Counted Today</span>';
  } else if (daysSince === 1) {
    return '<span class="badge" style="background: #dbeafe; color: #1e40af;">&#128197; Yesterday</span>';
  } else if (daysSince < 7) {
    return `<span class="badge" style="background: #dbeafe; color: #1e40af;">&#128197; ${daysSince} days ago</span>`;
  } else if (daysSince < 30) {
    const weeks = Math.floor(daysSince / 7);
    return `<span class="badge" style="background: #fef3c7; color: #92400e;">&#128197; ${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago</span>`;
  } else if (daysSince < 365) {
    const months = Math.floor(daysSince / 30);
    return `<span class="badge" style="background: #fee2e2; color: #991b1b;">&#128197; ${months} ${months === 1 ? 'month' : 'months'} ago</span>`;
  } else {
    const years = Math.floor(daysSince / 365);
    return `<span class="badge" style="background: #dc2626; color: white;">&#128197; ${years}+ ${years === 1 ? 'year' : 'years'} ago</span>`;
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  lastLoadTime = Date.now();
  loadPendingItems();
  // Load pinned count for badge (tab label)
  loadPinnedVariations().catch(() => {});

  // Handle image errors via delegation for cycle count images
  document.addEventListener('error', function(event) {
    if (event.target.classList && event.target.classList.contains('cycle-count-image')) {
      event.target.style.display = 'none';
      const nextSibling = event.target.nextElementSibling;
      if (nextSibling && nextSibling.classList.contains('no-image')) {
        nextSibling.style.display = 'flex';
      }
    }
  }, true);

  // Close modals on background click
  document.getElementById('send-now-modal').addEventListener('click', (e) => {
    if (e.target.id === 'send-now-modal') closeSendNowModal();
  });
  document.getElementById('count-modal').addEventListener('click', (e) => {
    if (e.target.id === 'count-modal') closeCountModal();
  });
  document.getElementById('category-batch-modal').addEventListener('click', (e) => {
    if (e.target.id === 'category-batch-modal') closeCategoryBatchModal();
  });

  // Close generate dropdown on outside click
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('generate-dropdown-wrap');
    if (wrap && !wrap.contains(e.target)) {
      wrap.classList.remove('open');
    }
  });

  // Reload dropdown when switching between category/vendor
  document.querySelectorAll('input[name="batch-type"]').forEach(radio => {
    radio.addEventListener('change', loadCategoryBatchDropdown);
  });
});

// Refresh data when tab becomes visible (with debounce and scroll preservation)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Only reload if more than 30 seconds since last load
    const timeSinceLastLoad = Date.now() - lastLoadTime;
    if (timeSinceLastLoad > 30000) {
      loadPendingItems(true); // Preserve scroll position
    }
  }
});

// ── Category / Vendor batch ───────────────────────────────────────────────────

let categoryBatchCache = { categories: [], vendors: [] };

async function showCategoryBatchModal() {
  document.getElementById('category-batch-modal').classList.add('active');
  document.getElementById('batch-preview-result').textContent = '';
  document.getElementById('submit-category-batch-btn').disabled = true;
  await loadCategoryBatchDropdown();
}

function closeCategoryBatchModal() {
  document.getElementById('category-batch-modal').classList.remove('active');
  document.getElementById('batch-preview-result').textContent = '';
  document.getElementById('submit-category-batch-btn').disabled = true;
}

async function loadCategoryBatchDropdown() {
  const type = document.querySelector('input[name="batch-type"]:checked').value;
  const select = document.getElementById('batch-select');
  document.getElementById('batch-select-label').textContent = type === 'category' ? 'Category:' : 'Vendor:';
  document.getElementById('batch-preview-result').textContent = '';
  document.getElementById('submit-category-batch-btn').disabled = true;
  select.innerHTML = '<option value="">Loading...</option>';

  try {
    let items;
    if (type === 'category') {
      if (categoryBatchCache.categories.length === 0) {
        const res = await fetch('/api/categories');
        const data = await res.json();
        categoryBatchCache.categories = data.categories || [];
      }
      items = categoryBatchCache.categories.map(name => ({ id: name, label: name }));
    } else {
      if (categoryBatchCache.vendors.length === 0) {
        const res = await fetch('/api/vendors');
        const data = await res.json();
        categoryBatchCache.vendors = data.vendors || [];
      }
      items = categoryBatchCache.vendors.map(v => ({ id: v.id, label: v.name }));
    }

    if (items.length === 0) {
      select.innerHTML = `<option value="">No ${type === 'category' ? 'categories' : 'vendors'} found</option>`;
    } else {
      select.innerHTML = '<option value="">Select...</option>' +
        items.map(item => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.label)}</option>`).join('');
    }
  } catch (err) {
    select.innerHTML = '<option value="">Error loading options</option>';
    showToast('Error loading options: ' + err.message, 'error');
  }
}

async function previewCategoryBatch() {
  const type = document.querySelector('input[name="batch-type"]:checked').value;
  const id = document.getElementById('batch-select').value;
  if (!id) {
    showToast('Please select a ' + (type === 'category' ? 'category' : 'vendor'), 'error');
    return;
  }

  const previewEl = document.getElementById('batch-preview-result');
  const btn = document.getElementById('preview-category-batch-btn');
  previewEl.textContent = 'Loading...';
  previewEl.style.color = '#6b7280';
  btn.disabled = true;

  try {
    const res = await fetch(`/api/cycle-counts/preview-category-batch?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Preview failed');

    const count = data.total_found;
    if (count > 0) {
      previewEl.textContent = `${count} item${count !== 1 ? 's' : ''} will be added to your count queue`;
      previewEl.style.color = '#059669';
      document.getElementById('submit-category-batch-btn').disabled = false;
    } else {
      previewEl.textContent = `No trackable items found for this ${type}`;
      previewEl.style.color = '#6b7280';
      document.getElementById('submit-category-batch-btn').disabled = true;
    }
  } catch (err) {
    previewEl.textContent = 'Preview failed: ' + err.message;
    previewEl.style.color = '#dc2626';
    document.getElementById('submit-category-batch-btn').disabled = true;
  } finally {
    btn.disabled = false;
  }
}

async function submitCategoryBatch() {
  const type = document.querySelector('input[name="batch-type"]:checked').value;
  const id = document.getElementById('batch-select').value;
  if (!id) return;

  const btn = document.getElementById('submit-category-batch-btn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const res = await fetch('/api/cycle-counts/generate-category-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id, added_by: 'Mobile User' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    const { items_added, items_skipped } = data;
    const skipMsg = items_skipped > 0 ? ` (${items_skipped} already queued)` : '';
    showToast(`${items_added} item${items_added !== 1 ? 's' : ''} added to count queue${skipMsg}`, 'success');
    closeCategoryBatchModal();
    setTimeout(() => loadPendingItems(), 500);
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Generate Count';
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(element, event, tabId) {
  document.querySelectorAll('#main-tabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  element.classList.add('active');
  document.getElementById('tab-' + tabId).classList.add('active');

  if (tabId === 'pinned-group') {
    loadPinnedVariations();
  }
}

// ── Pinned Group tab ─────────────────────────────────────────────────────────
// TODO: extract to public/js/utils/variation-picker.js when used a third time

let pinnedVariations = [];
let pinnedSearchTimeout = null;

async function loadPinnedVariations() {
  try {
    const res = await fetch('/api/cycle-counts/pinned');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load pinned group');
    pinnedVariations = data.variations || [];
    renderPinnedList();
    updatePinnedBadge();
  } catch (err) {
    console.error('Failed to load pinned variations:', err);
  }
}

function updatePinnedBadge() {
  const badge = document.getElementById('pinned-count-badge');
  if (badge) badge.textContent = pinnedVariations.length;
  const countEl = document.getElementById('pinned-list-count');
  if (countEl) countEl.textContent = pinnedVariations.length;
}

function renderPinnedList() {
  const container = document.getElementById('pinned-variation-list');
  if (!container) return;
  if (pinnedVariations.length === 0) {
    container.innerHTML = '<div class="var-pick-empty">No variations pinned. Search above to add items to your pinned count group.</div>';
    return;
  }
  container.innerHTML = pinnedVariations.map(v => `
    <div class="var-pick-row">
      <div class="var-pick-info">
        <div class="var-pick-name">${escapeHtml(v.item_name || 'Unknown Item')}</div>
        <div class="var-pick-sub">${escapeHtml(v.variation_name || '')}${v.sku ? ' &bull; SKU: ' + escapeHtml(v.sku) : ''}</div>
      </div>
      <button class="btn btn-danger" style="padding:4px 10px;font-size:12px;"
        data-action="removePinnedVariation" data-action-param="${escapeAttr(v.variation_id)}">&#10005;</button>
    </div>
  `).join('');
}

function onPinnedSearchInput(element) {
  clearTimeout(pinnedSearchTimeout);
  const query = element.value.trim();
  const resultsEl = document.getElementById('pinned-search-results');
  if (query.length < 2) {
    resultsEl.style.display = 'none';
    resultsEl.innerHTML = '';
    return;
  }
  pinnedSearchTimeout = setTimeout(() => searchPinnedVariations(query), 300);
}

async function searchPinnedVariations(query) {
  const resultsEl = document.getElementById('pinned-search-results');
  resultsEl.style.display = 'block';
  resultsEl.innerHTML = '<div class="var-pick-empty">Searching...</div>';

  try {
    const res = await fetch(`/api/variations?search=${encodeURIComponent(query)}&limit=20`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');

    const items = data.variations || data.items || [];
    if (items.length === 0) {
      resultsEl.innerHTML = '<div class="var-pick-empty">No results found.</div>';
      return;
    }

    resultsEl.innerHTML = items.map(v => {
      const alreadyPinned = pinnedVariations.some(p => p.variation_id === v.id);
      return `
        <div class="var-pick-row">
          <div class="var-pick-info">
            <div class="var-pick-name">${escapeHtml(v.item_name || v.name || 'Unknown')}</div>
            <div class="var-pick-sub">${escapeHtml(v.variation_name || v.name || '')}${v.sku ? ' &bull; SKU: ' + escapeHtml(v.sku) : ''}</div>
          </div>
          ${alreadyPinned
            ? '<span style="font-size:12px;color:#059669;">&#10003; Pinned</span>'
            : `<button class="btn btn-primary" style="padding:4px 10px;font-size:12px;"
                data-action="addPinnedVariation"
                data-action-param="${escapeAttr(JSON.stringify({ id: v.id, variation_name: v.variation_name || v.name, item_name: v.item_name, sku: v.sku || '' }))}">+ Add</button>`
          }
        </div>
      `;
    }).join('');
  } catch (err) {
    resultsEl.innerHTML = `<div class="var-pick-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function addPinnedVariation(element, event, paramJson) {
  let v;
  try { v = JSON.parse(paramJson); } catch { return; }

  try {
    const res = await fetch('/api/cycle-counts/pinned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variations: [{ variation_id: v.id, variation_name: v.variation_name, item_name: v.item_name, sku: v.sku }] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add variation');

    await loadPinnedVariations();
    // Refresh search results to update button state
    const query = document.getElementById('pinned-variation-search').value.trim();
    if (query.length >= 2) searchPinnedVariations(query);
    showToast('Added to pinned group', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function removePinnedVariation(element, event, variationId) {
  try {
    const res = await fetch(`/api/cycle-counts/pinned/${encodeURIComponent(variationId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove variation');

    pinnedVariations = pinnedVariations.filter(v => v.variation_id !== variationId);
    renderPinnedList();
    updatePinnedBadge();
    // Refresh search results to clear "Pinned" label
    const query = document.getElementById('pinned-variation-search').value.trim();
    if (query.length >= 2) searchPinnedVariations(query);
    showToast('Removed from pinned group', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function sendPinnedGroupFromTab() {
  const btn = document.getElementById('send-pinned-tab-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res = await fetch('/api/cycle-counts/pinned/send', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send pinned group');

    if (data.pushed === 0 && data.message) {
      showToast(data.message, 'info');
    } else {
      showToast(`${data.pushed} pinned item${data.pushed !== 1 ? 's' : ''} added to priority queue`, 'success');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📌 Send to Queue';
  }
}

// ── Generate Count Batch dropdown ────────────────────────────────────────────

function toggleGenerateDropdown() {
  const wrap = document.getElementById('generate-dropdown-wrap');
  wrap.classList.toggle('open');
}

function closeGenerateDropdown() {
  const wrap = document.getElementById('generate-dropdown-wrap');
  wrap.classList.remove('open');
}

async function generateBatchOption() {
  closeGenerateDropdown();
  await generateBatch();
}

async function showCategoryBatchModalOption() {
  closeGenerateDropdown();
  document.getElementById('batch-type-category').checked = true;
  await showCategoryBatchModal();
}

async function showVendorBatchModalOption() {
  closeGenerateDropdown();
  document.getElementById('batch-type-vendor').checked = true;
  await showCategoryBatchModal();
}

async function sendPinnedGroupOption() {
  closeGenerateDropdown();
  try {
    const res = await fetch('/api/cycle-counts/pinned/send', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to send pinned group');
    }
    if (data.pushed === 0 && data.message) {
      showToast(data.message, 'info');
    } else {
      showToast(`${data.pushed} pinned item${data.pushed !== 1 ? 's' : ''} added to priority queue`, 'success');
      setTimeout(() => loadPendingItems(), 500);
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// Expose functions to global scope for event delegation
window.showSendNowModal = showSendNowModal;
window.generateBatch = generateBatch;
window.loadPendingItems = loadPendingItems;
window.closeSendNowModal = closeSendNowModal;
window.submitSendNow = submitSendNow;
window.closeCountModal = closeCountModal;
window.submitCount = submitCount;
window.showCountModal = showCountModal;
window.showCategoryBatchModal = showCategoryBatchModal;
window.closeCategoryBatchModal = closeCategoryBatchModal;
window.previewCategoryBatch = previewCategoryBatch;
window.submitCategoryBatch = submitCategoryBatch;
window.toggleGenerateDropdown = toggleGenerateDropdown;
window.generateBatchOption = generateBatchOption;
window.showCategoryBatchModalOption = showCategoryBatchModalOption;
window.showVendorBatchModalOption = showVendorBatchModalOption;
window.sendPinnedGroupOption = sendPinnedGroupOption;
window.switchTab = switchTab;
window.onPinnedSearchInput = onPinnedSearchInput;
window.addPinnedVariation = addPinnedVariation;
window.removePinnedVariation = removePinnedVariation;
window.sendPinnedGroupFromTab = sendPinnedGroupFromTab;
