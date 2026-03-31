/**
 * Min Stock Adjustment History Page
 *
 * Displays paginated audit log of auto min/max adjustments.
 * Supports date range and rule filtering, and per-row pin/unpin controls.
 */

const PAGE_SIZE = 50;

let currentPage = 0;
let currentTotal = 0;
let currentFilters = {};

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', () => {
    setDefaultDates();
    loadHistory();
    document.getElementById('apply-filters').addEventListener('click', applyFilters);
    document.getElementById('reset-filters').addEventListener('click', resetFilters);
    document.getElementById('prev-page').addEventListener('click', () => changePage(-1));
    document.getElementById('next-page').addEventListener('click', () => changePage(1));

    // Event delegation for pin buttons
    document.getElementById('history-body').addEventListener('click', (e) => {
        const btn = e.target.closest('.mmh-pin-btn');
        if (btn) handlePinClick(btn);
    });
});

function setDefaultDates() {
    const today = new Date();
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    document.getElementById('end-date').value = formatDateInput(today);
    document.getElementById('start-date').value = formatDateInput(sevenDaysAgo);
}

function formatDateInput(date) {
    return date.toISOString().slice(0, 10);
}

// ==================== DATA LOADING ====================

async function loadHistory() {
    const tbody = document.getElementById('history-body');
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Loading…</td></tr>';

    const params = new URLSearchParams();
    params.set('limit', PAGE_SIZE);
    params.set('offset', currentPage * PAGE_SIZE);

    if (currentFilters.startDate) params.set('startDate', currentFilters.startDate + 'T00:00:00Z');
    if (currentFilters.endDate) params.set('endDate', currentFilters.endDate + 'T23:59:59Z');
    if (currentFilters.rule) params.set('rule', currentFilters.rule);

    try {
        const res = await fetch(`/api/min-max/history?${params}`);
        const data = await res.json();

        if (!data.success) {
            tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load history.</td></tr>`;
            showToast('Failed to load history', 'error');
            return;
        }

        currentTotal = data.total || 0;
        renderTable(data.items || []);
        renderSummary(data.items || []);
        renderPagination();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Network error.</td></tr>`;
        showToast('Network error loading history', 'error');
    }
}

// ==================== RENDER ====================

function renderTable(items) {
    const tbody = document.getElementById('history-body');

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No adjustments found for this period.</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(row => {
        const isReduced = row.new_min < row.previous_min;
        const isIncreased = row.new_min > row.previous_min;
        const rowClass = isReduced ? 'mmh-row-reduced' : isIncreased ? 'mmh-row-increased' : '';

        const date = formatDateTime(row.created_at);
        const itemName = escapeHtml(row.item_name || '—');
        const varName = escapeHtml(row.variation_name || '—');
        const sku = escapeHtml(row.sku || '—');
        const rule = escapeHtml(formatRule(row.rule));
        const reason = escapeHtml(row.reason || '—');
        const variationId = escapeAttr(row.variation_id);
        const locationId = escapeAttr(row.location_id);

        return `
          <tr class="${escapeAttr(rowClass)}">
            <td>${escapeHtml(date)}</td>
            <td>${itemName}</td>
            <td>${varName}</td>
            <td>${sku}</td>
            <td>${rule}</td>
            <td>${escapeHtml(String(row.previous_min))}</td>
            <td>${escapeHtml(String(row.new_min))}</td>
            <td>${reason}</td>
            <td>
              <button class="mmh-pin-btn"
                      data-variation-id="${variationId}"
                      data-location-id="${locationId}"
                      data-pinned="false"
                      title="Pin this item to prevent auto-adjustment">
                Pin
              </button>
            </td>
          </tr>`;
    }).join('');
}

function formatRule(rule) {
    const labels = {
        OVERSTOCKED: 'Overstocked',
        SOLDOUT_FAST_MOVER: 'Sold Out',
        EXPIRING: 'Expiring',
        MANUAL_APPLY: 'Manual',
        CRON_AUTO: 'Auto (cron)',
    };
    return labels[rule] || rule || '—';
}

function renderSummary(items) {
    const reduced = items.filter(r => r.new_min < r.previous_min).length;
    const increased = items.filter(r => r.new_min > r.previous_min).length;

    document.getElementById('stat-total').textContent = currentTotal;
    document.getElementById('stat-reduced').textContent = reduced;
    document.getElementById('stat-increased').textContent = increased;
}

function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
    document.getElementById('page-info').textContent = `Page ${currentPage + 1} of ${totalPages}`;
    document.getElementById('total-info').textContent = `${currentTotal} total`;
    document.getElementById('prev-page').disabled = currentPage === 0;
    document.getElementById('next-page').disabled = (currentPage + 1) * PAGE_SIZE >= currentTotal;
}

// ==================== FILTERS ====================

function applyFilters() {
    currentFilters = {
        startDate: document.getElementById('start-date').value,
        endDate: document.getElementById('end-date').value,
        rule: document.getElementById('rule-filter').value,
    };
    currentPage = 0;
    loadHistory();
}

function resetFilters() {
    document.getElementById('rule-filter').value = '';
    currentFilters = {};
    currentPage = 0;
    setDefaultDates();
    loadHistory();
}

function changePage(delta) {
    const newPage = currentPage + delta;
    const maxPage = Math.ceil(currentTotal / PAGE_SIZE) - 1;
    if (newPage < 0 || newPage > maxPage) return;
    currentPage = newPage;
    loadHistory();
}

// ==================== PIN ====================

async function handlePinClick(btn) {
    const variationId = btn.dataset.variationId;
    const locationId = btn.dataset.locationId;
    const currentlyPinned = btn.dataset.pinned === 'true';
    const newPinned = !currentlyPinned;

    btn.disabled = true;

    try {
        const res = await fetch('/api/min-max/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variationId, locationId, pinned: newPinned })
        });
        const data = await res.json();

        if (!data.success) {
            showToast('Failed to update pin', 'error');
            btn.disabled = false;
            return;
        }

        btn.dataset.pinned = String(newPinned);
        btn.textContent = newPinned ? 'Unpin' : 'Pin';
        btn.classList.toggle('pinned', newPinned);
        showToast(newPinned ? 'Item pinned — auto-adjustment disabled' : 'Item unpinned', 'success');
    } catch (err) {
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
    }
}
