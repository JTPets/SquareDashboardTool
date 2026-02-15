/**
 * Vendor Dashboard Page Logic
 *
 * Handles vendor listing with stats, filtering, sorting,
 * expandable detail rows, and inline vendor settings editing.
 *
 * Uses event-delegation.js for all user interactions (CSP compliant).
 */

(function() {
  'use strict';

  let allVendors = [];
  let globalOosCount = 0;
  let currentFilter = 'all';

  const STATUS_LABELS = {
    has_oos: 'HAS OOS',
    below_min: 'BELOW MIN',
    ready: 'READY',
    needs_order: 'NEEDS ORDER',
    ok: 'OK'
  };

  const STATUS_ORDER = { has_oos: 0, below_min: 1, ready: 2, needs_order: 3, ok: 4 };

  const DAY_ABBREV = {
    Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
    Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun'
  };

  // ==================== DATA LOADING ====================

  async function loadVendors() {
    try {
      var res = await fetch('/api/vendor-dashboard');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      allVendors = data.vendors || [];
      globalOosCount = data.global_oos_count || 0;
      updateSummary();
      renderTable();
    } catch (err) {
      document.getElementById('vendor-tbody').innerHTML =
        '<tr><td colspan="8" class="empty">Failed to load vendor data: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  // ==================== SUMMARY CARDS ====================

  function updateSummary() {
    // Use global deduplicated OOS count for summary (matches main dashboard)
    // Per-vendor oos_count in table rows can double-count multi-vendor items — that's correct per-vendor
    var totalReorder = allVendors.reduce(function(s, v) { return s + v.reorder_count; }, 0);
    var totalPoValue = allVendors.reduce(function(s, v) { return s + v.pending_po_value; }, 0);
    var actionCount = allVendors.filter(function(v) { return v.status !== 'ok'; }).length;

    var oosEl = document.getElementById('stat-oos');
    oosEl.textContent = globalOosCount;
    oosEl.className = globalOosCount > 0 ? 'stat-number alert' : 'stat-number';

    document.getElementById('stat-reorder').textContent = totalReorder;
    document.getElementById('stat-po-value').textContent = formatCurrency(totalPoValue);

    var actionEl = document.getElementById('stat-action');
    actionEl.textContent = actionCount;
    actionEl.className = actionCount > 0 ? 'stat-number alert' : 'stat-number';

    document.getElementById('filter-all').textContent = 'All (' + allVendors.length + ')';
    document.getElementById('filter-action').textContent = 'Needs Action (' + actionCount + ')';
  }

  // ==================== FILTERING & SORTING ====================

  function setFilter(filter) {
    currentFilter = filter;
    document.getElementById('filter-all').classList.toggle('active', filter === 'all');
    document.getElementById('filter-action').classList.toggle('active', filter === 'action');
    renderTable();
  }

  function getFilteredSorted() {
    var vendors = allVendors.slice();

    if (currentFilter === 'action') {
      vendors = vendors.filter(function(v) { return v.status !== 'ok'; });
    }

    var sortBy = document.getElementById('sort-select').value;
    vendors.sort(function(a, b) {
      if (sortBy === 'status') {
        var diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      }
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'last_ordered') {
        var dateA = a.last_ordered_at ? new Date(a.last_ordered_at) : new Date(0);
        var dateB = b.last_ordered_at ? new Date(b.last_ordered_at) : new Date(0);
        return dateA - dateB;
      }
      return 0;
    });

    return vendors;
  }

  // ==================== TABLE RENDERING ====================

  function renderTable() {
    var tbody = document.getElementById('vendor-tbody');
    var vendors = getFilteredSorted();

    if (vendors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No vendors match the current filter.</td></tr>';
      return;
    }

    tbody.innerHTML = vendors.map(function(v) {
      return renderVendorRow(v) + renderExpandedRow(v);
    }).join('');
  }

  function renderVendorRow(v) {
    return '<tr class="vendor-row" data-action="toggleExpand" data-action-param="' + escapeAttr(v.id) + '">' +
      '<td>' +
        '<div class="vendor-name">' + escapeHtml(v.name) + '</div>' +
        '<div class="vendor-items">' + v.total_items + ' items</div>' +
      '</td>' +
      '<td><span class="badge badge-' + v.status + '">' + STATUS_LABELS[v.status] + '</span></td>' +
      '<td>' + renderSchedule(v) + '</td>' +
      '<td>' + (v.oos_count > 0 ? '<span class="pill pill-red">' + v.oos_count + '</span>' : '<span class="pill pill-grey">0</span>') + '</td>' +
      '<td>' + renderReorderPill(v.reorder_count) + '</td>' +
      '<td>' + renderPoProgress(v) + '</td>' +
      '<td>' + renderLastOrdered(v.last_ordered_at) + '</td>' +
      '<td>' + renderPaymentBadge(v.payment_method) + '</td>' +
    '</tr>';
  }

  function renderSchedule(v) {
    if (v.schedule_type === 'fixed' && v.order_day && v.receive_day) {
      return (DAY_ABBREV[v.order_day] || v.order_day) + ' &rarr; ' + (DAY_ABBREV[v.receive_day] || v.receive_day);
    }
    if (v.lead_time_days != null) {
      return '~' + v.lead_time_days + 'd lead';
    }
    return '<span style="color:#9ca3af">--</span>';
  }

  function renderReorderPill(count) {
    if (count === 0) return '<span class="pill pill-grey">0</span>';
    return count > 5
      ? '<span class="pill pill-yellow">' + count + '</span>'
      : '<span class="pill pill-grey">' + count + '</span>';
  }

  function renderPoProgress(v) {
    var min = v.minimum_order_amount;
    var pending = v.pending_po_value;

    if (!min || min === 0) {
      return '<span style="color:#9ca3af">No min</span>';
    }
    if (pending === 0) {
      return '<span style="color:#6b7280">' + formatCurrency(min) + '</span>';
    }

    var pct = Math.min(100, Math.round((pending / min) * 100));
    var met = pending >= min;
    return '<div class="po-progress">' +
      '<div class="po-progress-text">' + formatCurrency(pending) + ' / ' + formatCurrency(min) + '</div>' +
      '<div class="po-progress-bar"><div class="po-progress-fill ' + (met ? 'met' : 'unmet') + '" style="width:' + pct + '%"></div></div>' +
    '</div>';
  }

  function renderLastOrdered(dateStr) {
    if (!dateStr) return '<span style="color:#9ca3af">Never</span>';
    var days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
    var cls = '';
    if (days > 60) cls = 'last-ordered-red';
    else if (days > 30) cls = 'last-ordered-yellow';
    return '<span class="' + cls + '">' + days + 'd ago</span>';
  }

  function renderPaymentBadge(method) {
    if (!method) return '<span style="color:#9ca3af">--</span>';
    var clsMap = {
      'Credit Card': 'payment-credit-card',
      'Invoice': 'payment-invoice',
      'E-Transfer': 'payment-e-transfer',
      'COD': 'payment-cod',
      'N/A': 'payment-na'
    };
    var cls = clsMap[method] || 'payment-na';
    return '<span class="payment-badge ' + cls + '">' + escapeHtml(method) + '</span>';
  }

  // ==================== EXPANDED ROW ====================

  function renderExpandedRow(v) {
    var vid = escapeAttr(v.id);
    var dayOptions = renderDayOptions;

    return '<tr class="expanded-row" id="expand-' + vid + '">' +
      '<td colspan="8"><div class="expanded-content">' +
        // View Mode
        '<div class="view-mode" id="view-' + vid + '">' +
          '<div class="detail-grid">' +
            '<div class="detail-section">' +
              '<h4>Contact &amp; Ordering</h4>' +
              detailRow('Email', v.contact_email) +
              detailRow('Order Method', v.order_method) +
              detailRow('Payment', v.payment_method) +
              detailRow('Terms', v.payment_terms) +
            '</div>' +
            '<div class="detail-section">' +
              '<h4>Schedule &amp; Settings</h4>' +
              detailRow('Schedule', v.schedule_type === 'fixed' ? 'Fixed Day' : 'Anytime') +
              (v.schedule_type === 'fixed'
                ? detailRow('Order Day', v.order_day) + detailRow('Receive Day', v.receive_day)
                : detailRow('Lead Time', v.lead_time_days != null ? v.lead_time_days + ' days' : null)) +
              detailRow('Minimum Order', v.minimum_order_amount ? formatCurrency(v.minimum_order_amount) : 'None') +
              detailRow('Supply Days', v.default_supply_days || 'Default') +
            '</div>' +
            '<div class="detail-section">' +
              '<h4>Notes</h4>' +
              '<textarea class="detail-notes" readonly>' + escapeHtml(v.notes || '') + '</textarea>' +
            '</div>' +
          '</div>' +
          '<div class="action-buttons">' +
            '<a href="reorder.html?vendor_id=' + encodeURIComponent(v.id) + '" class="btn btn-primary">View Reorder Suggestions</a>' +
            '<a href="purchase-orders.html?vendor_id=' + encodeURIComponent(v.id) + '" class="btn btn-blue">Create Purchase Order</a>' +
            '<button class="btn btn-outline" data-action="enterEditMode" data-action-param="' + vid + '">Edit Vendor Settings</button>' +
            '<a href="purchase-orders.html?vendor_id=' + encodeURIComponent(v.id) + '&view=history" class="btn btn-secondary">Order History</a>' +
          '</div>' +
        '</div>' +
        // Edit Mode
        '<div class="edit-form" id="edit-' + vid + '">' +
          '<div class="edit-grid">' +
            formGroup('Schedule Type',
              '<select id="field-schedule_type-' + vid + '" data-change="toggleScheduleFields" data-action-param="' + vid + '">' +
                '<option value="anytime"' + (v.schedule_type !== 'fixed' ? ' selected' : '') + '>Anytime</option>' +
                '<option value="fixed"' + (v.schedule_type === 'fixed' ? ' selected' : '') + '>Fixed Day</option>' +
              '</select>') +
            '<div class="form-group" id="fg-order_day-' + vid + '" style="' + (v.schedule_type !== 'fixed' ? 'display:none' : '') + '">' +
              '<label>Order Day</label>' +
              '<select id="field-order_day-' + vid + '">' + dayOptions(v.order_day) + '</select>' +
            '</div>' +
            '<div class="form-group" id="fg-receive_day-' + vid + '" style="' + (v.schedule_type !== 'fixed' ? 'display:none' : '') + '">' +
              '<label>Receive Day</label>' +
              '<select id="field-receive_day-' + vid + '">' + dayOptions(v.receive_day) + '</select>' +
            '</div>' +
            '<div class="form-group" id="fg-lead_time-' + vid + '" style="' + (v.schedule_type === 'fixed' ? 'display:none' : '') + '">' +
              '<label>Lead Time (days)</label>' +
              '<input type="number" id="field-lead_time_days-' + vid + '" min="0" value="' + (v.lead_time_days != null ? v.lead_time_days : '') + '">' +
            '</div>' +
            formGroup('Minimum Order ($)',
              '<input type="number" id="field-minimum_order_amount-' + vid + '" min="0" step="0.01" value="' + (v.minimum_order_amount ? (v.minimum_order_amount / 100).toFixed(2) : '') + '">') +
            formGroup('Payment Method',
              '<select id="field-payment_method-' + vid + '">' +
                '<option value="">-- Select --</option>' +
                ['Credit Card', 'Invoice', 'E-Transfer', 'COD', 'N/A'].map(function(m) {
                  return '<option value="' + m + '"' + (v.payment_method === m ? ' selected' : '') + '>' + m + '</option>';
                }).join('') +
              '</select>') +
            formGroup('Payment Terms',
              '<input type="text" id="field-payment_terms-' + vid + '" value="' + escapeAttr(v.payment_terms || '') + '" placeholder="e.g. Net 14">') +
            formGroup('Contact Email',
              '<input type="email" id="field-contact_email-' + vid + '" value="' + escapeAttr(v.contact_email || '') + '">') +
            formGroup('Order Method',
              '<input type="text" id="field-order_method-' + vid + '" value="' + escapeAttr(v.order_method || '') + '" placeholder="e.g. Portal, Email CSV">') +
            formGroup('Default Supply Days',
              '<input type="number" id="field-default_supply_days-' + vid + '" min="1" value="' + (v.default_supply_days || '') + '">') +
            '<div class="form-group" style="grid-column: 1 / -1">' +
              '<label>Notes</label>' +
              '<textarea id="field-notes-' + vid + '">' + escapeHtml(v.notes || '') + '</textarea>' +
            '</div>' +
          '</div>' +
          '<div class="form-actions">' +
            '<button class="btn btn-green" data-action="saveVendorSettings" data-action-param="' + vid + '">Save</button>' +
            '<button class="btn btn-outline" data-action="cancelEdit" data-action-param="' + vid + '">Cancel</button>' +
          '</div>' +
        '</div>' +
      '</div></td></tr>';
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) +
      '</span><span class="detail-value">' + escapeHtml(value || 'N/A') + '</span></div>';
  }

  function formGroup(label, innerHtml) {
    return '<div class="form-group"><label>' + escapeHtml(label) + '</label>' + innerHtml + '</div>';
  }

  function renderDayOptions(selected) {
    var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return '<option value="">-- Select --</option>' +
      days.map(function(d) {
        return '<option value="' + d + '"' + (selected === d ? ' selected' : '') + '>' + d + '</option>';
      }).join('');
  }

  // ==================== EXPAND / COLLAPSE ====================

  function toggleExpand(el, event, id) {
    // Don't toggle if clicking a link or button inside the row
    if (event.target.closest('a, button, input, select, textarea')) return;

    var row = document.getElementById('expand-' + id);
    if (!row) return;
    var wasVisible = row.classList.contains('visible');

    // Collapse all
    document.querySelectorAll('.expanded-row.visible').forEach(function(r) { r.classList.remove('visible'); });
    // Reset all edit modes
    document.querySelectorAll('.edit-form.visible').forEach(function(f) {
      f.classList.remove('visible');
      var viewId = f.id.replace('edit-', 'view-');
      var viewEl = document.getElementById(viewId);
      if (viewEl) viewEl.classList.remove('hidden');
    });

    if (!wasVisible) row.classList.add('visible');
  }

  // ==================== EDIT MODE ====================

  function enterEditMode(el, event, id) {
    event.stopPropagation();
    document.getElementById('view-' + id).classList.add('hidden');
    document.getElementById('edit-' + id).classList.add('visible');
  }

  function cancelEdit(el, event, id) {
    event.stopPropagation();
    document.getElementById('edit-' + id).classList.remove('visible');
    document.getElementById('view-' + id).classList.remove('hidden');
  }

  function toggleScheduleFields(el, event, id) {
    var type = document.getElementById('field-schedule_type-' + id).value;
    var isFixed = type === 'fixed';
    document.getElementById('fg-order_day-' + id).style.display = isFixed ? '' : 'none';
    document.getElementById('fg-receive_day-' + id).style.display = isFixed ? '' : 'none';
    document.getElementById('fg-lead_time-' + id).style.display = isFixed ? 'none' : '';
  }

  async function saveVendorSettings(el, event, id) {
    event.stopPropagation();

    function getVal(field) {
      var fieldEl = document.getElementById('field-' + field + '-' + id);
      return fieldEl ? fieldEl.value : '';
    }

    var scheduleType = getVal('schedule_type');
    var body = {
      schedule_type: scheduleType,
      order_day: scheduleType === 'fixed' ? (getVal('order_day') || null) : null,
      receive_day: scheduleType === 'fixed' ? (getVal('receive_day') || null) : null,
      lead_time_days: getVal('lead_time_days') !== '' ? parseInt(getVal('lead_time_days')) : null,
      minimum_order_amount: getVal('minimum_order_amount') !== '' ? Math.round(parseFloat(getVal('minimum_order_amount')) * 100) : 0,
      payment_method: getVal('payment_method') || null,
      payment_terms: getVal('payment_terms') || null,
      contact_email: getVal('contact_email') || null,
      order_method: getVal('order_method') || null,
      default_supply_days: getVal('default_supply_days') !== '' ? parseInt(getVal('default_supply_days')) : null,
      notes: getVal('notes') || null
    };

    try {
      var res = await fetch('/api/vendors/' + encodeURIComponent(id) + '/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      var data = await res.json();

      if (!res.ok) {
        var msg = data.details
          ? data.details.map(function(d) { return d.message; }).join(', ')
          : (data.error || 'Save failed');
        showToast(msg, 'error');
        return;
      }

      showToast('Vendor settings saved', 'success');
      await loadVendors();
    } catch (err) {
      showToast('Network error: ' + err.message, 'error');
    }
  }

  // ==================== HELPERS ====================

  function formatCurrency(cents) {
    if (cents == null) return '$0.00';
    return '$' + (cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showToast(message, type) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + type + ' visible';
    setTimeout(function() { toast.classList.remove('visible'); }, 3000);
  }

  // ==================== EVENT DELEGATION REGISTRATION ====================

  PageActions.register({
    toggleExpand: toggleExpand,
    enterEditMode: enterEditMode,
    cancelEdit: cancelEdit,
    saveVendorSettings: saveVendorSettings,
    toggleScheduleFields: toggleScheduleFields,
    setFilterAll: function() { setFilter('all'); },
    setFilterAction: function() { setFilter('action'); },
    sortVendors: function() { renderTable(); }
  });

  // ==================== INIT ====================
  loadVendors();
})();
