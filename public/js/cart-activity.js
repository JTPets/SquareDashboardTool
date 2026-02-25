/**
 * Cart Activity Page JavaScript
 * Externalized from cart-activity.html for CSP compliance (S-4)
 */

    // State
    let carts = [];
    let total = 0;
    let limit = 50;
    let offset = 0;

    // DOM elements
    const loadingEl = document.getElementById('loading');
    const cartListEl = document.getElementById('cart-list');
    const cartTbodyEl = document.getElementById('cart-tbody');
    const emptyStateEl = document.getElementById('empty-state');
    const paginationEl = document.getElementById('pagination');
    const paginationInfoEl = document.getElementById('pagination-info');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');

    // Stats elements
    const statPending = document.getElementById('stat-pending');
    const statConverted = document.getElementById('stat-converted');
    const statAbandoned = document.getElementById('stat-abandoned');
    const statRate = document.getElementById('stat-rate');

    // Filter elements
    const filterStatus = document.getElementById('filter-status');
    const filterStart = document.getElementById('filter-start');
    const filterEnd = document.getElementById('filter-end');

    /**
     * Format currency (cents to dollars)
     */
    function formatCurrency(cents) {
      if (!cents && cents !== 0) return '--';
      return '$' + (cents / 100).toFixed(2);
    }

    /**
     * Format date
     */
    function formatDate(dateStr) {
      if (!dateStr) return '--';
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    }

    /**
     * Calculate age and return formatted string with class
     */
    function formatAge(createdAt) {
      if (!createdAt) return { text: '--', class: '' };
      const created = new Date(createdAt);
      const now = new Date();
      const diffMs = now - created;
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHours / 24);

      if (diffDays > 7) {
        return { text: `${diffDays}d`, class: 'danger' };
      } else if (diffDays > 3) {
        return { text: `${diffDays}d`, class: 'warning' };
      } else if (diffDays > 0) {
        return { text: `${diffDays}d`, class: '' };
      } else {
        return { text: `${diffHours}h`, class: '' };
      }
    }

    /**
     * Format items preview with count and quantity
     */
    function formatItems(itemsJson, itemCount) {
      if (!itemsJson || itemCount === 0) return 'No items';
      try {
        const items = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson;
        if (!Array.isArray(items) || items.length === 0) return 'No items';

        // Calculate total quantity across all items
        const totalQty = items.reduce((sum, i) => sum + (parseInt(i.quantity, 10) || 1), 0);

        // Format first item with quantity
        const first = items[0];
        const qty = parseInt(first.quantity, 10) || 1;
        const firstItem = qty > 1 ? `${qty}x ${first.name}` : first.name;

        // Build preview string
        if (items.length === 1) {
          return totalQty === 1 ? `1 item: ${firstItem}` : `${totalQty} units: ${firstItem}`;
        } else {
          return `${items.length} items: ${firstItem}...`;
        }
      } catch {
        return `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
      }
    }

    /**
     * Format items for tooltip (full list)
     */
    function formatItemsTooltip(itemsJson) {
      if (!itemsJson) return '';
      try {
        const items = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson;
        if (!Array.isArray(items) || items.length === 0) return '';
        return items.map(i => {
          const qty = parseInt(i.quantity, 10) || 1;
          return qty > 1 ? `${qty}x ${i.name}` : i.name;
        }).join('\n');
      } catch {
        return '';
      }
    }

    /**
     * Get status badge HTML
     */
    function getStatusBadge(status) {
      const labels = {
        pending: 'Pending',
        converted: 'Converted',
        abandoned: 'Abandoned',
        canceled: 'Canceled'
      };
      return `<span class="status-badge status-${status}">${labels[status] || status}</span>`;
    }

    /**
     * Render cart table
     */
    function renderCarts() {
      if (carts.length === 0) {
        loadingEl.style.display = 'none';
        cartListEl.style.display = 'none';
        emptyStateEl.style.display = 'block';
        paginationEl.style.display = 'none';
        return;
      }

      cartTbodyEl.innerHTML = carts.map(cart => {
        const age = formatAge(cart.created_at);
        const tooltip = formatItemsTooltip(cart.items_json);
        const source = cart.source_name && cart.source_name !== 'Unknown' ? cart.source_name : '\u2014';
        return `
          <tr>
            <td>${formatDate(cart.created_at)}</td>
            <td>
              <div class="items-preview" title="${tooltip}">
                ${formatItems(cart.items_json, cart.item_count)}
              </div>
            </td>
            <td><span class="cart-value">${formatCurrency(cart.cart_total_cents)}</span></td>
            <td>${source}</td>
            <td>${getStatusBadge(cart.status)}</td>
            <td><span class="age-badge ${age.class}">${age.text}</span></td>
          </tr>
        `;
      }).join('');

      loadingEl.style.display = 'none';
      cartListEl.style.display = 'block';
      emptyStateEl.style.display = 'none';
      paginationEl.style.display = 'flex';

      // Update pagination
      const start = offset + 1;
      const end = Math.min(offset + carts.length, total);
      paginationInfoEl.textContent = `Showing ${start}-${end} of ${total}`;
      btnPrev.disabled = offset === 0;
      btnNext.disabled = offset + limit >= total;
    }

    /**
     * Fetch stats
     */
    async function fetchStats() {
      try {
        const res = await fetch('/api/cart-activity/stats?days=7');
        if (!res.ok) throw new Error('Failed to fetch stats');
        const stats = await res.json();

        statPending.textContent = stats.pending;
        statConverted.textContent = stats.converted;
        statAbandoned.textContent = stats.abandoned;
        statRate.textContent = stats.conversionRate + '%';
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      }
    }

    /**
     * Fetch carts
     */
    async function fetchCarts() {
      loadingEl.style.display = 'block';
      cartListEl.style.display = 'none';
      emptyStateEl.style.display = 'none';

      try {
        const params = new URLSearchParams({
          limit: limit.toString(),
          offset: offset.toString()
        });

        const status = filterStatus.value;
        if (status) params.set('status', status);

        const startDate = filterStart.value;
        if (startDate) params.set('startDate', startDate);

        const endDate = filterEnd.value;
        if (endDate) params.set('endDate', endDate);

        const res = await fetch(`/api/cart-activity?${params}`);
        if (!res.ok) throw new Error('Failed to fetch carts');
        const data = await res.json();

        carts = data.carts;
        total = data.total;
        renderCarts();
      } catch (err) {
        console.error('Failed to fetch carts:', err);
        loadingEl.textContent = 'Failed to load cart activity. Please try again.';
      }
    }

    /**
     * Handle filter changes
     */
    function handleFilter() {
      offset = 0;
      fetchCarts();
    }

    /**
     * Handle pagination
     */
    function handlePrev() {
      offset = Math.max(0, offset - limit);
      fetchCarts();
    }

    function handleNext() {
      offset += limit;
      fetchCarts();
    }

    // Event delegation
    document.addEventListener('change', (e) => {
      if (e.target.dataset.action === 'filter') {
        handleFilter();
      }
    });

    document.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action === 'prev') handlePrev();
      if (action === 'next') handleNext();
    });

    // Initial load
    fetchStats();
    fetchCarts();
