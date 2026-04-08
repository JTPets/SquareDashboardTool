/**
 * Vendor Match Suggestions — Frontend JS
 * BACKLOG-114: Cross-vendor product matching review UI
 */

const PAGE_SIZE = 50;

let currentStatus = 'pending';
let currentOffset = 0;
let currentTotal = 0;
let suggestions = [];

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Event delegation for clicks (CSP-compliant, no inline handlers)
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.dataset.action;
        if (action === 'switchTab') {
            switchTab(target.dataset.status, target);
        } else if (action === 'runBackfill') {
            runBackfill();
        } else if (action === 'confirmBulkApprove') {
            confirmBulkApprove();
        } else if (action === 'loadMore') {
            loadMore();
        } else if (action === 'approve') {
            approve(parseInt(target.dataset.id, 10));
        } else if (action === 'reject') {
            reject(parseInt(target.dataset.id, 10));
        }
    });

    // Event delegation for change events (checkboxes)
    document.addEventListener('change', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.dataset.action;
        if (action === 'toggleSelectAll') {
            toggleSelectAll(target);
        } else if (action === 'updateBulkButton') {
            updateBulkButton();
        }
    });

    loadStats();
    loadSuggestions('pending', 0, false);
});

// ============================================================================
// TABS
// ============================================================================

function switchTab(status, el) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    currentStatus = status;
    currentOffset = 0;
    suggestions = [];

    // Bulk bar only shown for pending tab
    document.getElementById('bulkBar').style.display = status === 'pending' ? 'flex' : 'none';

    loadSuggestions(status, 0, false);
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadStats() {
    try {
        const [pending, approved, rejected] = await Promise.all([
            fetch('/api/vendor-match-suggestions/count').then(r => r.json()),
            fetchCount('approved'),
            fetchCount('rejected')
        ]);
        document.getElementById('statPending').textContent = pending.count ?? '—';
        document.getElementById('statApproved').textContent = approved ?? '—';
        document.getElementById('statRejected').textContent = rejected ?? '—';
    } catch (e) {
        // non-fatal
    }
}

async function fetchCount(status) {
    try {
        const r = await fetch(`/api/vendor-match-suggestions?status=${status}&limit=1&offset=0`);
        const d = await r.json();
        return d.total ?? 0;
    } catch {
        return '—';
    }
}

async function loadSuggestions(status, offset, append) {
    const list = document.getElementById('suggestionList');
    if (!append) {
        list.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;">Loading…</div>';
    }

    try {
        const r = await fetch(`/api/vendor-match-suggestions?status=${status}&limit=${PAGE_SIZE}&offset=${offset}`);
        const data = await r.json();

        if (!data.success) throw new Error(data.error || 'Failed to load');

        currentTotal = data.total;
        currentOffset = offset + data.items.length;

        if (append) {
            suggestions = suggestions.concat(data.items);
        } else {
            suggestions = data.items;
            list.innerHTML = '';
        }

        if (suggestions.length === 0) {
            list.innerHTML = renderEmpty(status);
        } else {
            if (!append) list.innerHTML = '';
            data.items.forEach(s => {
                const div = document.createElement('div');
                div.innerHTML = renderCard(s);
                list.appendChild(div.firstElementChild);
            });
        }

        // Load more button
        const loadMoreRow = document.getElementById('loadMoreRow');
        loadMoreRow.style.display = currentOffset < currentTotal ? 'block' : 'none';

    } catch (e) {
        list.innerHTML = `<div class="empty-state"><p style="color:#dc2626;">Error: ${escHtml(e.message)}</p></div>`;
    }
}

function loadMore() {
    loadSuggestions(currentStatus, currentOffset, true);
}

// ============================================================================
// RENDERING
// ============================================================================

function renderEmpty(status) {
    const messages = {
        pending: { icon: '✅', title: 'No pending suggestions', body: 'All caught up! New suggestions appear here when vendor catalogs share a UPC.' },
        approved: { icon: '📋', title: 'No approved suggestions', body: 'Approved suggestions will appear here.' },
        rejected: { icon: '🚫', title: 'No rejected suggestions', body: 'Rejected suggestions will appear here.' }
    };
    const m = messages[status] || messages.pending;
    return `<div class="empty-state"><div class="icon">${m.icon}</div><h3>${m.title}</h3><p>${m.body}</p></div>`;
}

function renderCard(s) {
    const currentCost = s.source_cost_cents != null ? formatMoney(s.source_cost_cents) : 'N/A';
    const suggestedCost = s.suggested_cost_cents != null ? formatMoney(s.suggested_cost_cents) : 'N/A';

    let costClass = '';
    if (s.source_cost_cents != null && s.suggested_cost_cents != null) {
        costClass = s.suggested_cost_cents < s.source_cost_cents ? 'cost-cheaper' : 'cost-dearer';
    }

    const isPending = s.status === 'pending';
    const checkboxHtml = isPending
        ? `<input type="checkbox" class="suggestion-checkbox" data-id="${s.id}" data-action="updateBulkButton">`
        : '';

    const actionsHtml = isPending
        ? `<button class="btn-approve" data-action="approve" data-id="${s.id}">Approve</button>
           <button class="btn-reject" data-action="reject" data-id="${s.id}">Reject</button>`
        : `<span class="badge-${s.status}">${s.status}</span>`;

    const reviewedNote = s.reviewed_at
        ? `<span style="font-size:12px;color:#9ca3af;margin-right:8px;">Reviewed ${formatDate(s.reviewed_at)}${s.reviewed_by_name ? ' by ' + escHtml(s.reviewed_by_name) : ''}</span>`
        : '';

    return `
<div class="suggestion-card" data-id="${s.id}">
  <div class="suggestion-header">
    <div style="display:flex;align-items:flex-start;gap:12px;">
      ${checkboxHtml}
      <div>
        <div class="suggestion-product">${escHtml(s.item_name || s.variation_name || 'Unknown Product')}</div>
        <div class="suggestion-sku">SKU: ${escHtml(s.variation_sku || '—')}</div>
        <div class="suggestion-upc">UPC: ${escHtml(s.upc)}</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      ${reviewedNote}
      ${s.status !== 'pending' ? `<span class="badge-${s.status}">${s.status}</span>` : ''}
    </div>
  </div>

  <div class="vendor-comparison">
    <div class="vendor-box current">
      <div class="vendor-label">Current vendor</div>
      <div class="vendor-name">${escHtml(s.source_vendor_name)}</div>
      <div class="vendor-cost">${currentCost}</div>
    </div>
    <div class="arrow-icon">→</div>
    <div class="vendor-box suggested">
      <div class="vendor-label">Suggested vendor</div>
      <div class="vendor-name">${escHtml(s.suggested_vendor_name)}</div>
      <div class="vendor-cost ${costClass}">${suggestedCost}</div>
      ${s.suggested_vendor_code ? `<div class="vendor-code">${escHtml(s.suggested_vendor_code)}</div>` : ''}
    </div>
  </div>

  ${isPending ? `<div class="suggestion-actions">${actionsHtml}</div>` : ''}
</div>`;
}

// ============================================================================
// ACTIONS
// ============================================================================

async function approve(id) {
    setCardLoading(id, true);
    try {
        const r = await fetch(`/api/vendor-match-suggestions/${id}/approve`, { method: 'POST' });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Approval failed');

        removeCard(id);
        loadStats();
        notify('Approved — vendor link created' + (d.squarePushError ? ' (Square sync pending)' : ''), 'success');
    } catch (e) {
        setCardLoading(id, false);
        notify('Error: ' + e.message, 'error');
    }
}

async function reject(id) {
    setCardLoading(id, true);
    try {
        const r = await fetch(`/api/vendor-match-suggestions/${id}/reject`, { method: 'POST' });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Rejection failed');

        removeCard(id);
        loadStats();
        notify('Suggestion rejected', 'info');
    } catch (e) {
        setCardLoading(id, false);
        notify('Error: ' + e.message, 'error');
    }
}

async function confirmBulkApprove() {
    const checked = Array.from(document.querySelectorAll('.suggestion-checkbox:checked'));
    if (checked.length === 0) return;

    const confirmed = confirm(`Approve ${checked.length} suggestion${checked.length > 1 ? 's' : ''}? This will create vendor links and push to Square.`);
    if (!confirmed) return;

    const ids = checked.map(c => parseInt(c.dataset.id, 10));
    document.getElementById('btnBulkApprove').disabled = true;

    try {
        const r = await fetch('/api/vendor-match-suggestions/bulk-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Bulk approve failed');

        const { approved, failed } = d;
        loadSuggestions('pending', 0, false);
        loadStats();
        notify(`Approved ${approved}${failed > 0 ? `, ${failed} failed` : ''}`, approved > 0 ? 'success' : 'error');
    } catch (e) {
        notify('Error: ' + e.message, 'error');
        document.getElementById('btnBulkApprove').disabled = false;
    }
}

async function runBackfill() {
    const btn = document.getElementById('btnBackfill');
    btn.disabled = true;
    btn.textContent = 'Scanning…';

    try {
        const r = await fetch('/api/vendor-match-suggestions/backfill', { method: 'POST' });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Backfill failed');

        btn.textContent = 'Run Scan';
        btn.disabled = false;

        const { scanned, suggestionsCreated } = d;
        notify(`Scan complete — ${scanned} UPCs checked, ${suggestionsCreated} new suggestion${suggestionsCreated !== 1 ? 's' : ''} created`, 'success');
        loadSuggestions('pending', 0, false);
        loadStats();
    } catch (e) {
        btn.textContent = 'Run Scan';
        btn.disabled = false;
        notify('Error: ' + e.message, 'error');
    }
}

// ============================================================================
// SELECT ALL / BULK
// ============================================================================

function toggleSelectAll(master) {
    document.querySelectorAll('.suggestion-checkbox').forEach(c => {
        c.checked = master.checked;
    });
    updateBulkButton();
}

function updateBulkButton() {
    const checked = document.querySelectorAll('.suggestion-checkbox:checked').length;
    const btn = document.getElementById('btnBulkApprove');
    btn.disabled = checked === 0;
    btn.textContent = checked > 0 ? `Approve Selected (${checked})` : 'Approve Selected';
}

// ============================================================================
// HELPERS
// ============================================================================

function removeCard(id) {
    const card = document.querySelector(`.suggestion-card[data-id="${id}"]`);
    if (card) card.closest('div').remove();
}

function setCardLoading(id, loading) {
    const card = document.querySelector(`.suggestion-card[data-id="${id}"]`);
    if (!card) return;
    card.querySelectorAll('button').forEach(b => { b.disabled = loading; });
}

function formatMoney(cents) {
    if (cents == null) return 'N/A';
    return '$' + (cents / 100).toFixed(2);
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function notify(message, type) {
    const el = document.getElementById('notification');
    const colors = {
        success: { bg: '#d1fae5', color: '#065f46', border: '#34d399' },
        error:   { bg: '#fee2e2', color: '#991b1b', border: '#f87171' },
        info:    { bg: '#ede9fe', color: '#5b21b6', border: '#a78bfa' }
    };
    const c = colors[type] || colors.info;
    el.style.cssText = `display:block;position:fixed;bottom:24px;right:24px;padding:14px 20px;border-radius:8px;font-weight:600;z-index:1000;background:${c.bg};color:${c.color};border:1px solid ${c.border};max-width:360px;`;
    el.textContent = message;
    setTimeout(() => { el.style.display = 'none'; }, 4000);
}
