/**
 * Purchase Orders page JavaScript
 * Externalized from purchase-orders.html for CSP compliance (P0-4 Phase 2)
 */

// Global state
let currentPO = null;
let isEditMode = false;
let originalItems = [];
let confirmCallback = null;

// Helper function for safe DOM element updates
function safeSetContent(elementId, content, useInnerHTML) {
  useInnerHTML = useInnerHTML || false;
  const elem = document.getElementById(elementId);
  if (elem) {
    if (useInnerHTML) {
      elem.innerHTML = content;
    } else {
      elem.textContent = content;
    }
    return true;
  } else {
    console.error(`Element not found: ${elementId}`);
    return false;
  }
}

// Toast notification
function showToast(message, type) {
  type = type || 'success';
  const existingToast = document.querySelector('.toast');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-message">${escapeHtml(message)}</div>
    <button class="btn-icon" data-action="dismissToast">&#215;</button>
  `;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Dismiss toast notification (for data-action handler)
function dismissToast(element, event, param) {
  const toast = element.closest('.toast');
  if (toast) {
    toast.remove();
  }
}

async function loadPurchaseOrders() {
  const poListElem = document.getElementById('po-list');

  if (!poListElem) {
    console.error('po-list element not found');
    return;
  }

  try {
    const response = await fetch('/api/purchase-orders');
    const data = await response.json();
    const purchaseOrders = data.purchase_orders || [];

    if (purchaseOrders.length === 0) {
      poListElem.innerHTML = `
        <div class="empty-state">
          <h3>No Purchase Orders Yet</h3>
          <p>Create your first purchase order using the PO Generator.</p>
          <a href="/reorder.html" class="btn btn-primary" style="margin-top: 20px;">
            &#128230; Go to Reorder Suggestions
          </a>
        </div>
      `;
      return;
    }

    const tableHTML = `
      <table class="po-table">
        <thead>
          <tr>
            <th>PO Number</th>
            <th>Vendor</th>
            <th>Location</th>
            <th>Status</th>
            <th>Items</th>
            <th>Total</th>
            <th>Expected Delivery</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${purchaseOrders.map(po => `
            <tr>
              <td class="text-nowrap"><strong>${escapeHtml(po.po_number)}</strong></td>
              <td>${escapeHtml(po.vendor_name)}</td>
              <td>${escapeHtml(po.location_name)}</td>
              <td><span class="status-badge status-${po.status}">${po.status}</span></td>
              <td class="text-right">${po.item_count || 0}</td>
              <td class="text-right">$${(po.total_cents / 100).toFixed(2)}</td>
              <td class="text-nowrap">${formatDate(po.expected_delivery_date)}</td>
              <td class="text-nowrap">${formatDate(po.created_at)}</td>
              <td class="text-nowrap">
                <div class="btn-group">
                  <button data-action="viewPO" data-action-param="${po.id}"
                          class="btn btn-secondary btn-small"
                          title="View purchase order details">
                    &#128065; View
                  </button>
                  ${po.status === 'DRAFT' ? `
                    <button data-action="deletePO" data-action-param="${po.id}" data-po-number="${escapeHtml(po.po_number)}"
                            class="btn btn-danger btn-small"
                            title="Delete draft purchase order">
                      &#128465; Delete
                    </button>
                  ` : ''}
                  <a href="/api/purchase-orders/${po.po_number}/export-xlsx"
                     download="PO_${po.po_number}.xlsx"
                     class="btn btn-primary btn-small"
                     title="Download Square XLSX (recommended)">
                    &#128229; XLSX
                  </a>
                  <a href="/api/purchase-orders/${po.po_number}/export-csv"
                     download="PO_${po.po_number}.csv"
                     class="btn btn-secondary btn-small"
                     title="Download CSV (legacy)">
                    &#128196; CSV
                  </a>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    poListElem.innerHTML = tableHTML;
  } catch (error) {
    console.error('Failed to load purchase orders:', error);
    if (poListElem) {
      poListElem.innerHTML = `
        <div class="empty-state">
          <h3>Error Loading Purchase Orders</h3>
          <p>${escapeHtml(error.message)}</p>
        </div>
      `;
    }
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateString) {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch (error) {
    console.error('Date formatting error:', error);
    return '-';
  }
}

// View PO details in modal
async function viewPO(element, event, param) {
  const poId = param;
  const modal = document.getElementById('view-po-modal');
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');
  const modalFooter = document.getElementById('modal-footer');
  const modalContent = document.getElementById('modal-content');

  // Reset state
  isEditMode = false;
  modalContent.classList.remove('edit-mode');

  modal.classList.add('active');
  modalBody.innerHTML = '<div class="loading">Loading purchase order details...</div>';
  modalFooter.style.display = 'none';

  try {
    const response = await fetch(`/api/purchase-orders/${poId}`);
    if (!response.ok) throw new Error('Failed to load purchase order');

    currentPO = await response.json();
    originalItems = JSON.parse(JSON.stringify(currentPO.items || []));

    renderPODetails();

  } catch (error) {
    console.error('Failed to load PO details:', error);
    modalBody.innerHTML = `
      <div class="empty-state">
        <h3>Error Loading Purchase Order</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}

// Render PO details (view or edit mode)
function renderPODetails() {
  const po = currentPO;
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');
  const modalFooter = document.getElementById('modal-footer');
  const modalContent = document.getElementById('modal-content');

  modalTitle.textContent = `Purchase Order: ${po.po_number}`;

  // Edit mode indicator
  const editModeHTML = isEditMode ? `
    <div class="edit-mode-indicator">
      <strong>&#9999; Edit Mode</strong>
      <span>Make your changes below and click "Save Changes" when done.</span>
    </div>
  ` : '';

  // Items table
  const itemsTableHTML = po.items && po.items.length > 0 ? `
    <table class="po-items-table" id="items-table">
      <thead>
        <tr>
          <th>Product</th>
          <th>SKU</th>
          <th>Vendor Code</th>
          <th>GTIN/UPC</th>
          <th class="text-right">Qty Ordered</th>
          <th class="text-right">Unit Cost</th>
          <th class="text-right">Total</th>
          ${isEditMode ? '<th style="width: 50px;"></th>' : ''}
        </tr>
      </thead>
      <tbody id="items-tbody">
        ${po.items.map((item, index) => renderItemRow(item, index)).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="${isEditMode ? 7 : 6}" class="text-right"><strong>Total:</strong></td>
          <td class="text-right"><strong id="grand-total">$${calculateTotal().toFixed(2)}</strong></td>
          ${isEditMode ? '<td></td>' : ''}
        </tr>
      </tfoot>
    </table>
  ` : '<p>No items found</p>';

  // Supply days field
  const supplyDaysHTML = isEditMode ? `
    <input type="number"
           class="form-input edit-input"
           id="supply-days-input"
           value="${po.supply_days_override || ''}"
           min="1"
           max="365"
           style="width: 100px;">
  ` : '';

  // Notes field
  const notesHTML = isEditMode ? `
    <textarea class="form-input edit-input"
              id="notes-input"
              placeholder="Add notes...">${escapeHtml(po.notes || '')}</textarea>
  ` : '';

  modalBody.innerHTML = `
    ${editModeHTML}

    <div class="po-detail-section">
      <h3>Order Information</h3>
      <div class="po-info-grid">
        <div class="po-info-item">
          <span class="po-info-label">PO Number</span>
          <span class="po-info-value">${escapeHtml(po.po_number)}</span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Status</span>
          <span class="po-info-value"><span class="status-badge status-${po.status}">${po.status}</span></span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Vendor</span>
          <span class="po-info-value">${escapeHtml(po.vendor_name)}</span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Location</span>
          <span class="po-info-value">${escapeHtml(po.location_name)}</span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Supply Days</span>
          <span class="po-info-value">
            <span class="readonly-value">${po.supply_days_override || '-'}</span>
            ${supplyDaysHTML}
          </span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Expected Delivery</span>
          <span class="po-info-value">${formatDate(po.expected_delivery_date)}</span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Order Date</span>
          <span class="po-info-value">${formatDate(po.order_date)}</span>
        </div>
        <div class="po-info-item">
          <span class="po-info-label">Created</span>
          <span class="po-info-value">${formatDate(po.created_at)}</span>
        </div>
        ${po.created_by ? `
          <div class="po-info-item">
            <span class="po-info-label">Created By</span>
            <span class="po-info-value">${escapeHtml(po.created_by)}</span>
          </div>
        ` : ''}
      </div>

      <div class="form-group" style="margin-top: 15px;">
        <span class="po-info-label">Notes</span>
        <div class="po-info-value">
          <span class="readonly-value">${escapeHtml(po.notes || 'No notes')}</span>
          ${notesHTML}
        </div>
      </div>
    </div>

    <div class="po-detail-section">
      <h3>Items (${po.items ? po.items.length : 0})</h3>
      ${itemsTableHTML}
    </div>
  `;

  // Show footer with action buttons
  renderFooterButtons();
}

// Render individual item row
function renderItemRow(item, index) {
  const qtyInput = isEditMode ? `
    <input type="number"
           class="item-qty-input"
           data-index="${index}"
           value="${item.quantity_ordered}"
           min="0"
           step="any"
           data-change="updateItemQuantity">
  ` : item.quantity_ordered;

  const deleteBtn = isEditMode ? `
    <button class="btn-icon delete"
            data-action="removeItem" data-action-param="${index}"
            title="Remove item">
      &#128465;
    </button>
  ` : '';

  return `
    <tr data-index="${index}">
      <td>
        <strong>${escapeHtml(item.item_name)}</strong>
        ${item.variation_name ? `<br><small>${escapeHtml(item.variation_name)}</small>` : ''}
      </td>
      <td>${escapeHtml(item.sku || '-')}</td>
      <td>${escapeHtml(item.vendor_code || '-')}</td>
      <td>${escapeHtml(item.gtin || '-')}</td>
      <td class="text-right">${qtyInput}</td>
      <td class="text-right">$${(item.unit_cost_cents / 100).toFixed(2)}</td>
      <td class="text-right item-total" data-index="${index}">$${((item.quantity_ordered * item.unit_cost_cents) / 100).toFixed(2)}</td>
      ${isEditMode ? `<td class="text-center">${deleteBtn}</td>` : ''}
    </tr>
  `;
}

// Calculate total
function calculateTotal() {
  if (!currentPO || !currentPO.items) return 0;
  return currentPO.items.reduce((sum, item) => {
    return sum + (item.quantity_ordered * item.unit_cost_cents / 100);
  }, 0);
}

// Update item quantity
function updateItemQuantity(element, event, param) {
  const index = parseInt(element.dataset.index);
  const qty = parseFloat(element.value) || 0;

  currentPO.items[index].quantity_ordered = qty;

  // Update item total
  const itemTotal = (qty * currentPO.items[index].unit_cost_cents) / 100;
  const itemTotalElem = document.querySelector(`.item-total[data-index="${index}"]`);
  if (itemTotalElem) {
    itemTotalElem.textContent = `$${itemTotal.toFixed(2)}`;
  }

  // Update grand total
  const grandTotal = calculateTotal();
  const grandTotalElem = document.getElementById('grand-total');
  if (grandTotalElem) {
    grandTotalElem.textContent = `$${grandTotal.toFixed(2)}`;
  }
}

// Remove item
function removeItem(element, event, param) {
  const index = parseInt(param);
  if (!confirm('Remove this item from the purchase order?')) return;

  currentPO.items.splice(index, 1);
  renderPODetails();
}

// Render footer buttons based on PO status
function renderFooterButtons() {
  const modalFooter = document.getElementById('modal-footer');
  const po = currentPO;

  if (isEditMode) {
    // Edit mode buttons
    modalFooter.innerHTML = `
      <button class="btn btn-secondary" data-action="cancelEdit">Cancel</button>
      <button class="btn btn-success" data-action="saveChanges">&#128190; Save Changes</button>
    `;
    modalFooter.style.display = 'flex';
  } else if (po.status === 'DRAFT') {
    // DRAFT PO buttons
    modalFooter.innerHTML = `
      <button class="btn btn-secondary" data-action="closeModal">Close</button>
      <button class="btn btn-warning" data-action="enterEditMode">&#9999; Edit</button>
      <button class="btn btn-success" data-action="showSubmitConfirmation">&#10003; Submit PO</button>
    `;
    modalFooter.style.display = 'flex';
  } else {
    // Other statuses - just close button
    modalFooter.innerHTML = `
      <button class="btn btn-secondary" data-action="closeModal">Close</button>
    `;
    modalFooter.style.display = 'flex';
  }
}

// Enter edit mode
function enterEditMode() {
  isEditMode = true;
  const modalContent = document.getElementById('modal-content');
  modalContent.classList.add('edit-mode');
  renderPODetails();
}

// Cancel edit
function cancelEdit() {
  if (confirm('Discard all changes?')) {
    isEditMode = false;
    currentPO.items = JSON.parse(JSON.stringify(originalItems));
    const modalContent = document.getElementById('modal-content');
    modalContent.classList.remove('edit-mode');
    renderPODetails();
  }
}

// Save changes
async function saveChanges() {
  const po = currentPO;

  // Validate
  if (!po.items || po.items.length === 0) {
    showToast('Purchase order must have at least one item', 'error');
    return;
  }

  // Get updated values
  const supplyDaysInput = document.getElementById('supply-days-input');
  const notesInput = document.getElementById('notes-input');

  const updateData = {
    supply_days_override: supplyDaysInput ? (parseInt(supplyDaysInput.value) || null) : po.supply_days_override,
    notes: notesInput ? notesInput.value : po.notes,
    items: po.items.map(item => ({
      variation_id: item.variation_id,
      quantity_ordered: item.quantity_ordered,
      unit_cost_cents: item.unit_cost_cents
    }))
  };

  try {
    const response = await fetch(`/api/purchase-orders/${po.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || result.error || 'Failed to update purchase order');
    }

    showToast('Purchase order updated successfully', 'success');

    // Reload PO data
    isEditMode = false;
    const modalContent = document.getElementById('modal-content');
    modalContent.classList.remove('edit-mode');
    await viewPO(null, null, po.id);

    // Refresh the list
    loadPurchaseOrders();

  } catch (error) {
    console.error('Failed to save changes:', error);
    showToast(error.message, 'error');
  }
}

// Delete PO
async function deletePO(element, event, param) {
  const poId = param;
  const poNumber = element.dataset.poNumber || 'this PO';

  if (!confirm(`Are you sure you want to delete purchase order ${poNumber}?\n\nThis action cannot be undone.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/purchase-orders/${poId}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || 'Failed to delete purchase order');
    }

    alert(`Purchase order ${poNumber} deleted successfully`);
    loadPurchaseOrders(); // Reload the list

  } catch (error) {
    console.error('Failed to delete PO:', error);
    alert(`Error: ${error.message}`);
  }
}

// Show submit confirmation
function showSubmitConfirmation() {
  const po = currentPO;
  const confirmModal = document.getElementById('confirm-modal');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmBody = document.getElementById('confirm-body');
  const confirmBtn = document.getElementById('confirm-action-btn');

  confirmTitle.textContent = 'Submit Purchase Order';
  confirmBody.innerHTML = `
    <h3>Submit Purchase Order ${escapeHtml(po.po_number)}?</h3>

    <div class="warning-box">
      <strong>&#9888; Important</strong>
      <ul>
        <li>Once submitted, this PO cannot be edited or deleted</li>
        <li>The order date will be set to today</li>
        <li>Expected delivery date will be calculated based on vendor lead time</li>
      </ul>
    </div>

    <p><strong>Summary:</strong></p>
    <p>
      Vendor: ${escapeHtml(po.vendor_name)}<br>
      Items: ${po.items.length}<br>
      Total: $${calculateTotal().toFixed(2)}
    </p>

    <p>Are you sure you want to submit this purchase order?</p>
  `;

  confirmBtn.textContent = 'Submit PO';
  confirmBtn.className = 'btn btn-success';

  confirmCallback = submitPO;
  confirmModal.classList.add('active');
}

// Submit PO
async function submitPO() {
  const po = currentPO;

  try {
    const response = await fetch(`/api/purchase-orders/${po.id}/submit`, {
      method: 'POST'
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || result.error || 'Failed to submit purchase order');
    }

    showToast(`Purchase order ${po.po_number} submitted successfully`, 'success');

    closeConfirmModal();
    closeModal();

    // Refresh the list
    loadPurchaseOrders();

  } catch (error) {
    console.error('Failed to submit PO:', error);
    showToast(error.message, 'error');
    closeConfirmModal();
  }
}

// Confirm action (generic handler)
function confirmAction() {
  if (confirmCallback) {
    confirmCallback();
  }
}

// Close confirm modal
function closeConfirmModal() {
  const confirmModal = document.getElementById('confirm-modal');
  confirmModal.classList.remove('active');
  confirmCallback = null;
}

// Close modals
function closeModal() {
  const modal = document.getElementById('view-po-modal');
  modal.classList.remove('active');

  // Reset state
  currentPO = null;
  isEditMode = false;
  originalItems = [];
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function() {
  loadPurchaseOrders();

  // Close modal when clicking outside
  document.getElementById('view-po-modal').addEventListener('click', (e) => {
    if (e.target.id === 'view-po-modal') {
      if (isEditMode) {
        if (confirm('You have unsaved changes. Close anyway?')) {
          closeModal();
        }
      } else {
        closeModal();
      }
    }
  });

  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal') {
      closeConfirmModal();
    }
  });
});

// Expose functions to global scope for event delegation
window.closeModal = closeModal;
window.closeConfirmModal = closeConfirmModal;
window.confirmAction = confirmAction;
window.viewPO = viewPO;
window.deletePO = deletePO;
window.enterEditMode = enterEditMode;
window.cancelEdit = cancelEdit;
window.saveChanges = saveChanges;
window.showSubmitConfirmation = showSubmitConfirmation;
window.dismissToast = dismissToast;
window.removeItem = removeItem;
window.updateItemQuantity = updateItemQuantity;
