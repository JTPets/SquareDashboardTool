/**
 * GMC Feed Page JavaScript
 * Externalized from gmc-feed.html for CSP compliance (P0-4)
 */

    let allProducts = [];
    let filteredProducts = [];
    let currentPage = 1;
    const pageSize = 100;
    let currentFilter = 'all';
    let feedUrl = '';

    // Load GMC feed URL with token
    async function loadFeedUrl() {
      try {
        const response = await fetch('/api/gmc/feed-url');
        const data = await response.json();

        if (data.success && data.feedUrl) {
          feedUrl = data.feedUrl;
          document.getElementById('feed-url-input').value = feedUrl;
        } else {
          document.getElementById('feed-url-input').value = 'Error loading feed URL';
          document.getElementById('feed-url-input').style.color = '#dc2626';
        }
      } catch (error) {
        console.error('Error loading feed URL:', error);
        document.getElementById('feed-url-input').value = 'Error: ' + error.message;
        document.getElementById('feed-url-input').style.color = '#dc2626';
      }
    }

    // Copy feed URL to clipboard
    async function copyFeedUrl() {
      const input = document.getElementById('feed-url-input');
      try {
        await navigator.clipboard.writeText(input.value);
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.background = '#16a34a';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
        }, 2000);
      } catch (err) {
        // Fallback for older browsers
        input.select();
        document.execCommand('copy');
        alert('URL copied to clipboard');
      }
    }

    // Regenerate feed token (invalidates old URL)
    async function regenerateFeedToken() {
      if (!confirm('This will invalidate your current feed URL. You will need to update the URL in Google Merchant Center. Continue?')) {
        return;
      }

      try {
        const response = await fetch('/api/gmc/regenerate-token', { method: 'POST' });
        const data = await response.json();

        if (data.success && data.feedUrl) {
          feedUrl = data.feedUrl;
          document.getElementById('feed-url-input').value = feedUrl;
          document.getElementById('feed-url-input').style.color = '';
          alert('Token regenerated successfully. Please update the URL in Google Merchant Center.');
        } else {
          throw new Error(data.error || 'Failed to regenerate token');
        }
      } catch (error) {
        console.error('Error regenerating token:', error);
        alert('Error regenerating token: ' + error.message);
      }
    }

    // Load feed data
    async function loadFeedData() {
      try {
        document.getElementById('loading').style.display = 'block';
        document.getElementById('feed-table').style.display = 'none';

        const response = await fetch('/api/gmc/feed?include_products=true');
        const data = await response.json();

        if (!data.success) throw new Error(data.error || 'Failed to load feed');

        allProducts = data.products || [];
        filteredProducts = [...allProducts];

        updateStats();
        populateCategories();
        renderTable();

        document.getElementById('loading').style.display = 'none';
        document.getElementById('feed-table').style.display = 'table';

      } catch (error) {
        console.error('Load error:', error);
        document.getElementById('loading').innerHTML = 'Error loading feed: ' + escapeHtml(error.message);
      }
    }

    // Update stats
    function updateStats() {
      const total = allProducts.length;
      const inStock = allProducts.filter(p => p.availability === 'in_stock').length;
      const outStock = total - inStock;
      const noImage = allProducts.filter(p => !p.image_link).length;
      const noGtin = allProducts.filter(p => !p.gtin).length;
      const noBrand = allProducts.filter(p => !p.brand).length;

      document.getElementById('stat-total').textContent = total.toLocaleString();
      document.getElementById('stat-in-stock').textContent = inStock.toLocaleString();
      document.getElementById('stat-out-stock').textContent = outStock.toLocaleString();
      document.getElementById('stat-no-image').textContent = noImage.toLocaleString();
      document.getElementById('stat-no-gtin').textContent = noGtin.toLocaleString();
      document.getElementById('stat-no-brand').textContent = noBrand.toLocaleString();

      // Update badge counts
      document.querySelectorAll('.badge').forEach(badge => {
        const filter = badge.dataset.filter;
        let count = 0;
        switch(filter) {
          case 'all': count = total; break;
          case 'no-image': count = noImage; break;
          case 'no-gtin': count = noGtin; break;
          case 'no-brand': count = noBrand; break;
          case 'no-category': count = allProducts.filter(p => !p.google_product_category).length; break;
          case 'out-of-stock': count = outStock; break;
        }
        badge.textContent = badge.textContent.replace(/\s*\(\d+\)$/, '') + ` (${count})`;
      });
    }

    // Populate category dropdown
    function populateCategories() {
      const categories = [...new Set(allProducts.map(p => p.category).filter(Boolean))].sort();
      const select = document.getElementById('category-filter');
      select.innerHTML = '<option value="">All Categories</option>';
      categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        select.appendChild(opt);
      });
    }

    // Filter products
    function applyFilters() {
      const search = document.getElementById('search-input').value.toLowerCase();
      const category = document.getElementById('category-filter').value;

      filteredProducts = allProducts.filter(p => {
        // Search filter
        if (search) {
          const searchable = `${p.title} ${p.id} ${p.gtin} ${p.brand}`.toLowerCase();
          if (!searchable.includes(search)) return false;
        }

        // Category filter
        if (category && p.category !== category) return false;

        // Issue filter
        switch(currentFilter) {
          case 'no-image': if (p.image_link) return false; break;
          case 'no-gtin': if (p.gtin) return false; break;
          case 'no-brand': if (p.brand) return false; break;
          case 'no-category': if (p.google_product_category) return false; break;
          case 'out-of-stock': if (p.availability === 'in_stock') return false; break;
        }

        return true;
      });

      currentPage = 1;
      renderTable();
    }

    // Render table
    function renderTable() {
      const tbody = document.getElementById('table-body');
      const start = (currentPage - 1) * pageSize;
      const end = start + pageSize;
      const pageProducts = filteredProducts.slice(start, end);

      if (pageProducts.length === 0) {
        document.getElementById('feed-table').style.display = 'none';
        document.getElementById('empty-state').style.display = 'block';
      } else {
        document.getElementById('feed-table').style.display = 'table';
        document.getElementById('empty-state').style.display = 'none';
      }

      tbody.innerHTML = pageProducts.map(p => `
        <tr>
          <td>
            ${p.image_link
              ? `<img src="${p.image_link}" class="thumbnail" alt="" data-error-action="showImageError">`
              : '<div class="no-image">NONE</div>'}
          </td>
          <td style="font-family: monospace; font-size: 10px;" title="${escapeHtml(p.id || '')}">${p.id ? p.id.substring(0, 10) + '...' : '-'}</td>
          <td class="truncate" title="${escapeHtml(p.title || '')}">${escapeHtml(p.title || '-')}</td>
          <td class="url-cell" title="${escapeHtml(p.link || '')}">
            ${p.link ? `<a href="${escapeHtml(p.link)}" target="_blank">${escapeHtml(p.link.replace(/^https?:\/\/[^/]+/, '').substring(0, 30))}...</a>` : '<span class="status-warning">MISSING</span>'}
          </td>
          <td class="truncate" style="max-width: 120px;" title="${escapeHtml(p.description || '')}">${escapeHtml((p.description || '-').substring(0, 40))}${(p.description || '').length > 40 ? '...' : ''}</td>
          <td class="${p.gtin ? '' : 'status-warning'}" style="font-family: monospace; font-size: 10px;">${p.gtin || '-'}</td>
          <td class="truncate" style="max-width: 100px;">${escapeHtml(p.category || '-')}</td>
          <td class="url-cell ${p.image_link ? '' : 'status-bad'}" title="${escapeHtml(p.image_link || '')}">
            ${p.image_link ? `<a href="${escapeHtml(p.image_link)}" target="_blank">${escapeHtml(p.image_link.split('/').pop().substring(0, 20))}...</a>` : 'MISSING'}
          </td>
          <td style="font-size: 10px;">
            ${p.additional_image_link_1 ? `<a href="${escapeHtml(p.additional_image_link_1)}" target="_blank" title="${escapeHtml(p.additional_image_link_1)}">+1</a>` : ''}
            ${p.additional_image_link_2 ? `<a href="${escapeHtml(p.additional_image_link_2)}" target="_blank" title="${escapeHtml(p.additional_image_link_2)}" style="margin-left:4px;">+2</a>` : ''}
            ${!p.additional_image_link_1 && !p.additional_image_link_2 ? '-' : ''}
          </td>
          <td>${p.condition || 'new'}</td>
          <td class="${p.availability === 'in_stock' ? 'status-good' : 'status-bad'}">
            ${p.availability === 'in_stock' ? 'in_stock' : 'out_of_stock'}
          </td>
          <td>${p.quantity || 0}</td>
          <td class="${p.brand ? '' : 'status-bad'}">${escapeHtml(p.brand || 'MISSING')}</td>
          <td class="truncate ${p.google_product_category ? '' : 'status-warning'}" style="max-width: 150px;" title="${escapeHtml(p.google_product_category || '')}">
            ${escapeHtml(p.google_product_category || 'NOT MAPPED')}
          </td>
          <td style="white-space: nowrap;">${p.price || '-'}</td>
          <td>${p.adult || 'no'}</td>
          <td>${p.is_bundle || 'no'}</td>
        </tr>
      `).join('');

      updatePagination();
    }

    // Pagination
    function updatePagination() {
      const totalPages = Math.ceil(filteredProducts.length / pageSize) || 1;
      document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages} (${filteredProducts.length} products)`;
      document.getElementById('prev-btn').disabled = currentPage <= 1;
      document.getElementById('next-btn').disabled = currentPage >= totalPages;
    }

    function prevPage() {
      if (currentPage > 1) {
        currentPage--;
        renderTable();
      }
    }

    function nextPage() {
      const totalPages = Math.ceil(filteredProducts.length / pageSize);
      if (currentPage < totalPages) {
        currentPage++;
        renderTable();
      }
    }

    // Badge filter click
    document.querySelectorAll('.badge').forEach(badge => {
      badge.addEventListener('click', () => {
        document.querySelectorAll('.badge').forEach(b => b.classList.remove('active'));
        badge.classList.add('active');
        currentFilter = badge.dataset.filter;
        applyFilters();
      });
    });

    // Search and filter events
    document.getElementById('search-input').addEventListener('input', debounce(applyFilters, 300));
    document.getElementById('category-filter').addEventListener('change', applyFilters);

    // Download TSV using the token URL
    function downloadTsv() {
      if (feedUrl) {
        window.open(feedUrl, '_blank');
      } else {
        alert('Feed URL not available. Please refresh the page.');
      }
    }

    // Export CSV - includes all GMC feed fields
    function exportCsv() {
      const headers = [
        'id', 'title', 'link', 'description', 'gtin', 'category',
        'image_link', 'additional_image_link_1', 'additional_image_link_2',
        'condition', 'availability', 'quantity', 'brand',
        'google_product_category', 'price', 'adult', 'is_bundle'
      ];
      const rows = filteredProducts.map(p => headers.map(h => {
        let val = p[h] || '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      }).join(','));

      const csv = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gmc-feed-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    }

    // Utilities
    function debounce(fn, delay) {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
      };
    }

    // Escape strings for use in JavaScript onclick handlers (single-quoted)
    function escapeJsString(str) {
      if (!str) return '';
      return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
    }

    function formatTimeAgo(date) {
      const seconds = Math.floor((new Date() - date) / 1000);
      if (seconds < 60) return 'Just now';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
      return Math.floor(seconds / 86400) + 'd ago';
    }

    // ==================== BRAND MANAGER ====================
    let brandDetectionResults = null;

    function openBrandManager() {
      document.getElementById('brand-modal').classList.add('active');
      // Reset state
      document.getElementById('brand-results').style.display = 'none';
      document.getElementById('btn-apply-brands').disabled = true;
      document.getElementById('brand-status-msg').textContent = '';
    }

    function closeBrandManager() {
      document.getElementById('brand-modal').classList.remove('active');
    }

    // Close modal on overlay click
    document.getElementById('brand-modal').addEventListener('click', (e) => {
      if (e.target.id === 'brand-modal') closeBrandManager();
    });

    async function detectBrands() {
      const input = document.getElementById('brand-list-input').value;
      const brands = input.split('\n').map(b => b.trim()).filter(b => b);

      if (brands.length === 0) {
        alert('Please enter at least one brand name');
        return;
      }

      const btn = document.getElementById('btn-detect-brands');
      btn.disabled = true;
      btn.textContent = 'Detecting...';
      document.getElementById('brand-status-msg').textContent = 'Analyzing item names...';

      try {
        const response = await fetch('/api/gmc/brands/auto-detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brands })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Detection failed');

        brandDetectionResults = data;
        renderBrandResults(data);

        document.getElementById('brand-results').style.display = 'block';
        document.getElementById('btn-apply-brands').disabled = data.detected.length === 0;
        document.getElementById('brand-status-msg').textContent =
          `Found ${data.detected_count} matches from ${data.master_brands_provided} brands`;

      } catch (error) {
        alert('Error: ' + error.message);
        document.getElementById('brand-status-msg').textContent = 'Error: ' + error.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Detect Brands from Item Names';
      }
    }

    function renderBrandResults(data) {
      const tbody = document.getElementById('brand-matches-body');

      // Update stats
      document.getElementById('detected-count').textContent = data.detected_count;
      document.getElementById('no-match-count').textContent = data.no_match_count;
      updateSelectedCount();

      // Render matches table
      tbody.innerHTML = data.detected.map((item, idx) => `
        <tr>
          <td>
            <input type="checkbox" class="brand-checkbox" data-index="${idx}"
                   ${item.selected ? 'checked' : ''} data-change="updateSelectedCount">
          </td>
          <td title="${escapeHtml(item.item_name)}">${escapeHtml(item.item_name.substring(0, 60))}${item.item_name.length > 60 ? '...' : ''}</td>
          <td>${escapeHtml(item.category || '-')}</td>
          <td style="color: #16a34a; font-weight: 500;">${escapeHtml(item.detected_brand_name)}</td>
        </tr>
      `).join('');

      // Render no-match section
      if (data.no_match.length > 0) {
        document.getElementById('no-match-section').style.display = 'block';
        document.getElementById('no-match-total').textContent = data.no_match.length;
        document.getElementById('no-match-list').innerHTML = data.no_match
          .map(item => `<div>${escapeHtml(item.item_name)}</div>`)
          .join('');
      } else {
        document.getElementById('no-match-section').style.display = 'none';
      }
    }

    function toggleAllBrands(checked) {
      document.querySelectorAll('.brand-checkbox').forEach(cb => {
        cb.checked = checked;
      });
      updateSelectedCount();
    }

    // Wrapper for event delegation (data-change handler)
    function toggleAllBrandsFromCheckbox(element, event, param) {
      toggleAllBrands(element.checked);
    }

    function updateSelectedCount() {
      const selected = document.querySelectorAll('.brand-checkbox:checked').length;
      document.getElementById('selected-count').textContent = selected;
      document.getElementById('btn-apply-brands').disabled = selected === 0;
    }

    async function applyBrands() {
      if (!brandDetectionResults) return;

      const checkboxes = document.querySelectorAll('.brand-checkbox:checked');
      const assignments = [];

      checkboxes.forEach(cb => {
        const idx = parseInt(cb.dataset.index);
        const item = brandDetectionResults.detected[idx];
        assignments.push({
          item_id: item.item_id,
          brand_id: item.detected_brand_id
        });
      });

      if (assignments.length === 0) {
        alert('No items selected');
        return;
      }

      const btn = document.getElementById('btn-apply-brands');
      btn.disabled = true;
      btn.textContent = 'Applying...';
      document.getElementById('brand-status-msg').textContent = `Applying ${assignments.length} brand assignments...`;

      try {
        const response = await fetch('/api/gmc/brands/bulk-assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Assignment failed');

        const msg = `Applied ${data.assigned} brands. Synced ${data.synced_to_square} to Square.`;
        document.getElementById('brand-status-msg').textContent = msg;

        alert(msg + '\n\nRefreshing feed data...');
        closeBrandManager();
        loadFeedData(); // Refresh the main table

      } catch (error) {
        alert('Error: ' + error.message);
        document.getElementById('brand-status-msg').textContent = 'Error: ' + error.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Apply Selected Brands to Square';
      }
    }

    // ==================== CATEGORY MANAGER ====================
    let categoryMappings = {};  // Map of category_name -> {google_taxonomy_id, google_taxonomy_name}
    let productCategories = []; // Categories from products with counts
    let allTaxonomy = [];
    let filteredCategories = [];
    let filteredTaxonomy = [];
    let selectedCategory = null;
    let selectedTaxonomy = null;
    let categoryStatusFilter = 'all'; // 'all', 'mapped', or 'unmapped'

    function openCategoryManager() {
      document.getElementById('category-modal').classList.add('active');
      document.getElementById('category-status-msg').textContent = 'Loading...';
      selectedCategory = null;
      selectedTaxonomy = null;
      categoryStatusFilter = 'all';
      // Reset filter UI
      document.querySelectorAll('.category-stats .stat-filter').forEach(el => el.classList.remove('active'));
      document.getElementById('filter-all').classList.add('active');
      updateCategoryButtons();
      loadCategoryMappings();
      loadGoogleTaxonomy();
    }

    function setCategoryFilter(filter) {
      categoryStatusFilter = filter;
      // Update UI
      document.querySelectorAll('.category-stats .stat-filter').forEach(el => el.classList.remove('active'));
      document.getElementById(`filter-${filter}`).classList.add('active');
      // Re-filter with new status
      filterCategories();
    }

    function closeCategoryManager() {
      document.getElementById('category-modal').classList.remove('active');
    }

    // Close modal on overlay click
    document.getElementById('category-modal').addEventListener('click', (e) => {
      if (e.target.id === 'category-modal') closeCategoryManager();
    });

    async function loadCategoryMappings() {
      try {
        // Build categories from products (same as the dropdown)
        const categoryCounts = {};
        allProducts.forEach(p => {
          if (p.category) {
            categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1;
          }
        });

        // Get existing mappings from API
        const response = await fetch('/api/gmc/category-mappings');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load mappings');

        // Build mapping lookup by category name
        categoryMappings = {};
        (data.mappings || []).forEach(m => {
          if (m.category_name) {
            categoryMappings[m.category_name] = {
              category_id: m.category_id,
              google_taxonomy_id: m.google_taxonomy_id,
              google_taxonomy_name: m.google_taxonomy_name
            };
          }
        });

        // Build product categories list with counts and mapping status
        productCategories = Object.keys(categoryCounts).sort().map(name => {
          const mapping = categoryMappings[name] || {};
          return {
            category_name: name,
            category_id: mapping.category_id || null,
            product_count: categoryCounts[name],
            google_taxonomy_id: mapping.google_taxonomy_id || null,
            google_taxonomy_name: mapping.google_taxonomy_name || null
          };
        });

        filteredCategories = [...productCategories];
        renderCategories();
        updateCategoryStats();
        document.getElementById('category-status-msg').textContent = '';
      } catch (error) {
        document.getElementById('category-status-msg').textContent = 'Error: ' + error.message;
      }
    }

    async function loadGoogleTaxonomy() {
      try {
        const response = await fetch('/api/gmc/taxonomy?limit=10000');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load taxonomy');

        allTaxonomy = data.taxonomy || [];
        filteredTaxonomy = [...allTaxonomy];
        renderTaxonomy();

        // Show empty state if no taxonomy loaded
        const emptyState = document.getElementById('taxonomy-empty');
        if (emptyState) {
          emptyState.style.display = allTaxonomy.length === 0 ? 'block' : 'none';
        }
      } catch (error) {
        console.error('Failed to load taxonomy:', error);
      }
    }

    async function importGoogleTaxonomy() {
      const btn = document.getElementById('btn-import-taxonomy');
      const statusMsg = document.getElementById('category-status-msg');

      if (!confirm('Import Google\'s official product taxonomy? This will fetch ~5,600 categories from Google.')) {
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Importing...';
      statusMsg.textContent = 'Fetching Google taxonomy...';

      try {
        const response = await fetch('/api/gmc/taxonomy/fetch-google');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to import taxonomy');

        statusMsg.textContent = `Imported ${data.imported} Google taxonomy categories!`;
        btn.textContent = 'Import';
        btn.disabled = false;

        // Reload taxonomy
        await loadGoogleTaxonomy();

      } catch (error) {
        statusMsg.textContent = 'Error: ' + error.message;
        btn.textContent = 'Import';
        btn.disabled = false;
      }
    }

    function updateCategoryStats() {
      const total = productCategories.length;
      const mapped = productCategories.filter(c => c.google_taxonomy_id).length;
      const unmapped = total - mapped;

      document.getElementById('cat-total-count').textContent = total;
      document.getElementById('cat-mapped-count').textContent = mapped;
      document.getElementById('cat-unmapped-count').textContent = unmapped;
    }

    function filterCategories() {
      const search = document.getElementById('category-search').value.toLowerCase();
      filteredCategories = productCategories.filter(c => {
        // Apply text search filter
        if (search && !c.category_name.toLowerCase().includes(search)) {
          return false;
        }
        // Apply status filter
        if (categoryStatusFilter === 'mapped' && !c.google_taxonomy_id) {
          return false;
        }
        if (categoryStatusFilter === 'unmapped' && c.google_taxonomy_id) {
          return false;
        }
        return true;
      });
      renderCategories();
    }

    function filterTaxonomy() {
      const search = document.getElementById('taxonomy-search').value.toLowerCase();
      if (!search) {
        filteredTaxonomy = [...allTaxonomy];
      } else {
        filteredTaxonomy = allTaxonomy.filter(t =>
          t.name.toLowerCase().includes(search)
        );
      }
      renderTaxonomy();
    }

    function renderCategories() {
      const container = document.getElementById('category-list');
      container.innerHTML = filteredCategories.map(cat => `
        <div class="category-item ${cat.google_taxonomy_id ? 'mapped' : ''} ${selectedCategory?.category_name === cat.category_name ? 'selected' : ''}"
             data-action="selectCategory" data-action-param="${escapeJsString(cat.category_name)}">
          <div class="cat-name">${escapeHtml(cat.category_name)} <span class="cat-count">(${cat.product_count} products)</span></div>
          <div class="cat-mapping ${cat.google_taxonomy_id ? '' : 'not-mapped'}">
            ${cat.google_taxonomy_id
              ? `<span title="${escapeHtml(cat.google_taxonomy_name || '')}">${escapeHtml(cat.google_taxonomy_name || 'Unknown')}</span>`
              : 'Not mapped'}
          </div>
        </div>
      `).join('');
    }

    function renderTaxonomy() {
      const container = document.getElementById('taxonomy-list');
      const search = document.getElementById('taxonomy-search').value.toLowerCase();

      container.innerHTML = filteredTaxonomy.slice(0, 500).map(tax => {
        let displayName = escapeHtml(tax.name);
        if (search) {
          const regex = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          displayName = displayName.replace(regex, '<span class="highlight">$1</span>');
        }
        return `
          <div class="taxonomy-item ${selectedTaxonomy?.id === tax.id ? 'selected' : ''}"
               data-action="selectTaxonomy" data-action-param="${tax.id}">
            <span class="tax-id">${tax.id}</span>
            <span class="tax-name">${displayName}</span>
          </div>
        `;
      }).join('');

      if (filteredTaxonomy.length > 500) {
        container.innerHTML += `<div style="padding: 10px; color: #6b7280; text-align: center; font-size: 12px;">
          Showing 500 of ${filteredTaxonomy.length} results. Use search to narrow down.
        </div>`;
      }
    }

    function selectCategory(categoryName) {
      selectedCategory = productCategories.find(c => c.category_name === categoryName);
      renderCategories();
      updateCategoryButtons();

      // If category already has a mapping, scroll to and select that taxonomy
      if (selectedCategory?.google_taxonomy_id) {
        selectedTaxonomy = allTaxonomy.find(t => t.id === selectedCategory.google_taxonomy_id);
        if (selectedTaxonomy) {
          // Clear search and show full list with selection
          document.getElementById('taxonomy-search').value = '';
          filteredTaxonomy = [...allTaxonomy];
          renderTaxonomy();
          // Scroll to selected item
          setTimeout(() => {
            const selected = document.querySelector('.taxonomy-item.selected');
            if (selected) selected.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      } else {
        selectedTaxonomy = null;
        renderTaxonomy();
      }
    }

    function selectTaxonomy(taxonomyId) {
      selectedTaxonomy = allTaxonomy.find(t => t.id === taxonomyId);
      renderTaxonomy();
      updateCategoryButtons();
    }

    function updateCategoryButtons() {
      const assignBtn = document.getElementById('btn-assign-taxonomy');
      const removeBtn = document.getElementById('btn-remove-mapping');

      // Can assign if category selected and taxonomy selected
      assignBtn.disabled = !selectedCategory || !selectedTaxonomy;

      // Can remove if category selected and it has a mapping
      removeBtn.disabled = !selectedCategory || !selectedCategory.google_taxonomy_id;
    }

    async function assignTaxonomy() {
      if (!selectedCategory || !selectedTaxonomy) return;

      const statusMsg = document.getElementById('category-status-msg');
      statusMsg.textContent = 'Saving...';

      try {
        const response = await fetch('/api/gmc/category-taxonomy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category_name: selectedCategory.category_name,
            google_taxonomy_id: selectedTaxonomy.id
          })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to assign taxonomy');

        // Update local data
        const cat = productCategories.find(c => c.category_name === selectedCategory.category_name);
        if (cat) {
          cat.category_id = data.category_id;
          cat.google_taxonomy_id = selectedTaxonomy.id;
          cat.google_taxonomy_name = selectedTaxonomy.name;
        }

        // Update filtered copy too
        const filteredCat = filteredCategories.find(c => c.category_name === selectedCategory.category_name);
        if (filteredCat) {
          filteredCat.category_id = data.category_id;
          filteredCat.google_taxonomy_id = selectedTaxonomy.id;
          filteredCat.google_taxonomy_name = selectedTaxonomy.name;
        }

        selectedCategory = cat;
        renderCategories();
        updateCategoryStats();
        updateCategoryButtons();
        statusMsg.textContent = `Mapped "${cat.category_name}" → "${selectedTaxonomy.name}"`;

      } catch (error) {
        statusMsg.textContent = 'Error: ' + error.message;
      }
    }

    async function removeCategoryMapping() {
      if (!selectedCategory || !selectedCategory.google_taxonomy_id) return;

      if (!confirm(`Remove mapping for "${selectedCategory.category_name}"?`)) return;

      const statusMsg = document.getElementById('category-status-msg');
      statusMsg.textContent = 'Removing...';

      try {
        const response = await fetch('/api/gmc/category-taxonomy', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category_name: selectedCategory.category_name })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to remove mapping');

        // Update local data
        const cat = productCategories.find(c => c.category_name === selectedCategory.category_name);
        if (cat) {
          cat.google_taxonomy_id = null;
          cat.google_taxonomy_name = null;
        }

        // Update filtered copy too
        const filteredCat = filteredCategories.find(c => c.category_name === selectedCategory.category_name);
        if (filteredCat) {
          filteredCat.google_taxonomy_id = null;
          filteredCat.google_taxonomy_name = null;
        }

        selectedCategory = cat;
        selectedTaxonomy = null;
        renderCategories();
        renderTaxonomy();
        updateCategoryStats();
        updateCategoryButtons();
        statusMsg.textContent = `Removed mapping for "${cat.category_name}"`;

      } catch (error) {
        statusMsg.textContent = 'Error: ' + error.message;
      }
    }

    // ==================== TAB NAVIGATION ====================
    function switchTab(tabName) {
      // Update tab buttons
      document.querySelectorAll('.tab-nav button').forEach(btn => {
        btn.classList.remove('active');
      });
      event.target.classList.add('active');

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
      });
      document.getElementById(`tab-${tabName}`).classList.add('active');

      // Load data for the selected tab
      if (tabName === 'local-inventory') {
        loadLocationSettings();
      }
    }

    // ==================== GMC API SETTINGS ====================
    let gmcSettings = {};
    let gmcApiSettings = {};
    let locationSettings = [];

    // Toggle API settings panel
    function toggleApiSettings() {
      const panel = document.getElementById('api-settings-panel');
      const toggle = document.getElementById('api-settings-toggle');
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        toggle.textContent = '▲';
      } else {
        panel.style.display = 'none';
        toggle.textContent = '▼';
      }
    }

    // Toggle Feed settings panel
    function toggleFeedSettings() {
      const panel = document.getElementById('feed-settings-panel');
      const toggle = document.getElementById('feed-settings-toggle');
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        toggle.textContent = '▲';
      } else {
        panel.style.display = 'none';
        toggle.textContent = '▼';
      }
    }

    // Update feed URL badge based on settings
    function updateFeedUrlBadge() {
      const badge = document.getElementById('feed-url-badge');
      const baseUrl = document.getElementById('website-base-url').value;
      if (baseUrl && baseUrl !== 'https://your-store-url.com') {
        badge.textContent = 'Configured';
        badge.style.background = '#dcfce7';
        badge.style.color = '#166534';
      } else {
        badge.textContent = 'Not configured';
        badge.style.background = '#fee2e2';
        badge.style.color = '#991b1b';
      }
      updateUrlPreview();
    }

    // Update URL preview
    function updateUrlPreview() {
      const baseUrl = document.getElementById('website-base-url').value || 'https://yourstore.com';
      const pattern = document.getElementById('product-url-pattern').value || '/product/{slug}/{variation_id}';
      const preview = document.getElementById('url-preview');
      const previewText = document.getElementById('url-preview-text');

      const exampleUrl = baseUrl + pattern
        .replace('{slug}', 'blue-buffalo-chicken-dog-food')
        .replace('{variation_id}', 'ABC123XYZ');

      previewText.textContent = exampleUrl;
      preview.style.display = 'block';
    }

    // Load feed settings
    async function loadFeedSettings() {
      try {
        const response = await fetch('/api/gmc/settings');
        const data = await response.json();
        const settings = data.settings || {};

        document.getElementById('website-base-url').value = settings.website_base_url || '';
        document.getElementById('product-url-pattern').value = settings.product_url_pattern || '/product/{slug}/{variation_id}';
        document.getElementById('feed-currency').value = settings.currency || 'CAD';
        document.getElementById('feed-condition').value = settings.default_condition || 'new';

        updateFeedUrlBadge();
      } catch (error) {
        console.error('Failed to load feed settings:', error);
      }
    }

    // Save feed settings
    async function saveFeedSettings() {
      const statusEl = document.getElementById('feed-settings-status');
      statusEl.textContent = 'Saving...';
      statusEl.style.color = '#6b7280';

      try {
        const websiteBaseUrl = document.getElementById('website-base-url').value.trim();
        const productUrlPattern = document.getElementById('product-url-pattern').value.trim() || '/product/{slug}/{variation_id}';
        const currency = document.getElementById('feed-currency').value;
        const defaultCondition = document.getElementById('feed-condition').value;

        if (!websiteBaseUrl) {
          statusEl.textContent = 'Website Base URL is required';
          statusEl.style.color = '#dc2626';
          return;
        }

        // Validate URL format
        try {
          new URL(websiteBaseUrl);
        } catch (e) {
          statusEl.textContent = 'Invalid URL format. Use https://yourstore.com';
          statusEl.style.color = '#dc2626';
          return;
        }

        const response = await fetch('/api/gmc/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: {
              website_base_url: websiteBaseUrl,
              product_url_pattern: productUrlPattern,
              currency: currency,
              default_condition: defaultCondition
            }
          })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to save settings');

        statusEl.textContent = 'Settings saved! Reload feed to see updated URLs.';
        statusEl.style.color = '#16a34a';
        updateFeedUrlBadge();

        // Optionally reload feed data to show updated URLs
        setTimeout(() => {
          statusEl.textContent = '';
        }, 5000);
      } catch (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.style.color = '#dc2626';
      }
    }

    // Add input listeners for URL preview
    document.addEventListener('DOMContentLoaded', () => {
      const baseUrlInput = document.getElementById('website-base-url');
      const patternInput = document.getElementById('product-url-pattern');
      if (baseUrlInput) baseUrlInput.addEventListener('input', updateUrlPreview);
      if (patternInput) patternInput.addEventListener('input', updateUrlPreview);
    });

    // Update connection badge based on settings
    function updateConnectionBadge() {
      const badge = document.getElementById('gmc-connection-badge');
      if (gmcApiSettings.gmc_merchant_id && gmcApiSettings.gmc_data_source_id) {
        badge.textContent = 'Connected';
        badge.style.background = '#dcfce7';
        badge.style.color = '#166534';
      } else if (gmcApiSettings.gmc_merchant_id) {
        badge.textContent = 'Partial';
        badge.style.background = '#fef3c7';
        badge.style.color = '#92400e';
      } else {
        badge.textContent = 'Not configured';
        badge.style.background = '#fee2e2';
        badge.style.color = '#991b1b';
      }
    }

    // Copy local inventory feed URL
    async function copyLocalFeedUrl() {
      const input = document.getElementById('local-inventory-feed-url');
      try {
        await navigator.clipboard.writeText(input.value);
        const btn = event.target;
        btn.textContent = 'Copied!';
        btn.style.background = '#16a34a';
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.style.background = '#3b82f6';
        }, 2000);
      } catch (err) {
        input.select();
        document.execCommand('copy');
      }
    }

    // Load local inventory feed URL
    async function loadLocalInventoryFeedUrl() {
      try {
        const response = await fetch('/api/gmc/local-inventory-feed-url');
        const data = await response.json();
        if (data.success && data.feedUrl) {
          document.getElementById('local-inventory-feed-url').value = data.feedUrl;
        } else {
          document.getElementById('local-inventory-feed-url').value = window.location.origin + '/api/gmc/local-inventory-feed.tsv';
        }
      } catch (error) {
        document.getElementById('local-inventory-feed-url').value = window.location.origin + '/api/gmc/local-inventory-feed.tsv';
      }
    }

    async function loadGmcSettings() {
      try {
        // Load API settings (merchant ID, data source ID, feed label, language)
        const apiResponse = await fetch('/api/gmc/api-settings');
        const apiData = await apiResponse.json();
        gmcApiSettings = apiData.settings || {};
        document.getElementById('gmc-merchant-id').value = gmcApiSettings.gmc_merchant_id || '';
        document.getElementById('gmc-data-source-id').value = gmcApiSettings.gmc_data_source_id || '';
        document.getElementById('gmc-feed-label').value = gmcApiSettings.feed_label || '';
        document.getElementById('gmc-content-language').value = gmcApiSettings.content_language || '';

        // Update connection badge
        updateConnectionBadge();
      } catch (error) {
        console.error('Failed to load GMC settings:', error);
      }
    }

    async function saveGmcApiSettings() {
      try {
        const gmcMerchantId = document.getElementById('gmc-merchant-id').value.trim();
        const dataSourceId = document.getElementById('gmc-data-source-id').value.trim();
        const localDataSourceId = document.getElementById('gmc-local-data-source-id').value.trim();
        // Feed label and content language are now OPTIONAL
        // Leave empty to sync without them (for data sources with unset feed label)
        const feedLabelRaw = document.getElementById('gmc-feed-label').value.trim();
        const feedLabel = feedLabelRaw ? feedLabelRaw.toUpperCase() : '';
        const contentLanguageRaw = document.getElementById('gmc-content-language').value.trim();
        const contentLanguage = contentLanguageRaw ? contentLanguageRaw.toLowerCase() : '';

        if (!gmcMerchantId) {
          alert('Please enter your Merchant Center ID');
          return;
        }

        const response = await fetch('/api/gmc/api-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: {
              gmc_merchant_id: gmcMerchantId,
              gmc_data_source_id: dataSourceId,
              gmc_local_data_source_id: localDataSourceId,
              feed_label: feedLabel,
              content_language: contentLanguage
            }
          })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to save settings');

        // Update connection badge to reflect new settings
        gmcApiSettings.gmc_merchant_id = gmcMerchantId;
        gmcApiSettings.gmc_data_source_id = dataSourceId;
        gmcApiSettings.gmc_local_data_source_id = localDataSourceId;
        updateConnectionBadge();

        alert('Settings saved!');
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function testGmcConnection() {
      const statusEl = document.getElementById('gmc-connection-status');
      statusEl.style.display = 'block';
      statusEl.style.background = '#fef3c7';
      statusEl.style.color = '#92400e';
      statusEl.textContent = 'Testing connection...';

      try {
        // Save the settings first
        const gmcMerchantId = document.getElementById('gmc-merchant-id').value.trim();
        const dataSourceId = document.getElementById('gmc-data-source-id').value.trim();
        if (gmcMerchantId) {
          await fetch('/api/gmc/api-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { gmc_merchant_id: gmcMerchantId, gmc_data_source_id: dataSourceId } })
          });
        }

        const response = await fetch('/api/gmc/api/test-connection', { method: 'POST' });
        const data = await response.json();

        if (data.success) {
          statusEl.style.background = '#d1fae5';
          statusEl.style.color = '#065f46';
          statusEl.textContent = `Connected! Account: ${data.accountName || data.accountId}`;
        } else {
          statusEl.style.background = '#fee2e2';
          statusEl.style.color = '#991b1b';
          statusEl.textContent = `Connection failed: ${data.error}`;
        }
      } catch (error) {
        statusEl.style.background = '#fee2e2';
        statusEl.style.color = '#991b1b';
        statusEl.textContent = `Error: ${error.message}`;
      }
    }

    async function syncProductsToGmc() {
      const statusEl = document.getElementById('product-sync-status');
      statusEl.textContent = 'Starting sync...';
      statusEl.style.color = '#6b7280';

      try {
        const response = await fetch('/api/gmc/api/sync-products', { method: 'POST' });
        const data = await response.json();

        if (data.async) {
          // Sync is running in background
          statusEl.style.color = '#2563eb';
          statusEl.innerHTML = 'Sync running in background... <a href="#" data-action="loadSyncHistory" style="color: #2563eb;">Refresh history</a>';

          // Start polling for completion
          pollSyncStatus('product_catalog', statusEl);
        } else if (data.success) {
          statusEl.style.color = '#059669';
          statusEl.textContent = `Synced ${data.synced} of ${data.total} products`;
        } else {
          statusEl.style.color = '#dc2626';
          statusEl.textContent = `Error: ${data.error || 'Sync failed'}`;
        }

        if (data.errors && data.errors.length > 0) {
          console.log('Sync errors:', data.errors);
        }

        // Refresh sync history
        loadSyncHistory();
      } catch (error) {
        statusEl.style.color = '#dc2626';
        statusEl.textContent = `Error: ${error.message}`;
      }
    }

    // Poll sync status until complete
    async function pollSyncStatus(syncType, statusEl) {
      let attempts = 0;
      const maxAttempts = 120; // 10 minutes max

      const poll = async () => {
        attempts++;
        if (attempts > maxAttempts) {
          statusEl.textContent = 'Sync taking longer than expected. Check history.';
          return;
        }

        try {
          const response = await fetch('/api/gmc/api/sync-status');
          const data = await response.json();

          if (data.success && data.status[syncType]) {
            const status = data.status[syncType];

            if (status.status === 'in_progress') {
              // Still running, poll again
              setTimeout(poll, 5000);
            } else {
              // Sync complete
              loadSyncHistory();
              if (status.status === 'success') {
                statusEl.style.color = '#059669';
                statusEl.textContent = `Done! ${status.succeeded}/${status.total_items} synced`;
              } else if (status.status === 'partial') {
                statusEl.style.color = '#d97706';
                statusEl.textContent = `Partial: ${status.succeeded}/${status.total_items} synced, ${status.failed} failed`;
              } else {
                statusEl.style.color = '#dc2626';
                statusEl.textContent = `Failed. Check sync history for details.`;
              }
            }
          } else {
            // No status yet, keep polling
            setTimeout(poll, 5000);
          }
        } catch (err) {
          setTimeout(poll, 5000);
        }
      };

      // Start polling after 5 seconds
      setTimeout(poll, 5000);
    }

    // ==================== SYNC STATUS ====================

    async function loadSyncStatus() {
      try {
        const response = await fetch('/api/gmc/api/sync-status');
        const data = await response.json();

        if (data.success && data.status) {
          // Update inline product sync status with detailed counts
          const productStatus = data.status.product_catalog;
          const productEl = document.getElementById('last-product-sync-inline');
          if (productEl && productStatus) {
            const time = new Date(productStatus.started_at).toLocaleString();
            const statusIcon = productStatus.status === 'success' ? '✓' :
                              productStatus.status === 'partial' ? '⚠' :
                              productStatus.status === 'in_progress' ? '⏳' : '✗';

            // Build detailed status with counts
            let statusText = `${time} ${statusIcon}`;
            if (productStatus.total_items) {
              statusText += ` (${productStatus.succeeded || 0}/${productStatus.total_items} synced`;
              if (productStatus.failed > 0) {
                statusText += `, ${productStatus.failed} failed`;
              }
              statusText += ')';
            }

            productEl.textContent = statusText;
            productEl.style.color = productStatus.status === 'success' ? '#059669' :
                                   productStatus.status === 'partial' ? '#d97706' :
                                   productStatus.status === 'in_progress' ? '#2563eb' : '#dc2626';
          }

          // Update inventory sync status if element exists
          const inventoryStatus = data.status.local_inventory_all;
          const invEl = document.getElementById('last-inventory-sync-inline');
          if (invEl && inventoryStatus) {
            const time = new Date(inventoryStatus.started_at).toLocaleString();
            const statusIcon = inventoryStatus.status === 'success' ? '✓' :
                              inventoryStatus.status === 'partial' ? '⚠' :
                              inventoryStatus.status === 'in_progress' ? '⏳' : '✗';
            let statusText = `${time} ${statusIcon}`;
            if (inventoryStatus.total_items) {
              statusText += ` (${inventoryStatus.succeeded || 0}/${inventoryStatus.total_items})`;
            }
            invEl.textContent = statusText;
            invEl.style.color = inventoryStatus.status === 'success' ? '#059669' :
                               inventoryStatus.status === 'partial' ? '#d97706' : '#dc2626';
          }
        }
      } catch (error) {
        console.error('Failed to load sync status:', error);
      }
    }

    // Alias for backwards compatibility - just refreshes sync status
    function loadSyncHistory() {
      loadSyncStatus();
    }

    async function loadLocationSettings() {
      try {
        const response = await fetch('/api/gmc/location-settings');
        const data = await response.json();
        locationSettings = data.locations || [];

        renderLocationSettings();
        populateLocalInventoryLocationSelect();
      } catch (error) {
        console.error('Failed to load location settings:', error);
        document.getElementById('location-settings-body').innerHTML =
          '<tr><td colspan="5" style="text-align: center; color: #dc2626;">Error loading locations</td></tr>';
      }
    }

    // ==================== LOCAL INVENTORY PREVIEW ====================
    let localInventoryData = [];
    let filteredLocalInventory = [];
    let localInventoryPage = 1;
    const localInventoryPageSize = 100;

    function populateLocalInventoryLocationSelect() {
      const select = document.getElementById('local-inventory-location-select');
      select.innerHTML = '<option value="">Select a location...</option>';

      locationSettings.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.location_id;
        opt.textContent = `${loc.location_name}${loc.google_store_code ? ` (${loc.google_store_code})` : ''}`;
        select.appendChild(opt);
      });
    }

    async function loadLocalInventoryPreview() {
      const locationId = document.getElementById('local-inventory-location-select').value;

      if (!locationId) {
        document.getElementById('local-inventory-empty').style.display = 'block';
        document.getElementById('local-inventory-table').style.display = 'none';
        document.getElementById('local-inventory-stats').style.display = 'none';
        document.getElementById('local-inventory-pagination').style.display = 'none';
        return;
      }

      document.getElementById('local-inventory-empty').style.display = 'none';
      document.getElementById('local-inventory-loading').style.display = 'block';
      document.getElementById('local-inventory-table').style.display = 'none';

      try {
        const response = await fetch(`/api/gmc/local-inventory-feed?location_id=${locationId}&format=json`);
        const data = await response.json();

        if (!data.success) throw new Error(data.error || 'Failed to load inventory');

        localInventoryData = data.items || [];
        filteredLocalInventory = [...localInventoryData];
        localInventoryPage = 1;

        // Update stats
        const inStock = localInventoryData.filter(i => i.quantity > 0).length;
        const outStock = localInventoryData.length - inStock;
        document.getElementById('li-stat-total').textContent = localInventoryData.length.toLocaleString();
        document.getElementById('li-stat-in-stock').textContent = inStock.toLocaleString();
        document.getElementById('li-stat-out-stock').textContent = outStock.toLocaleString();
        document.getElementById('li-stat-store-code').textContent = data.location?.store_code || '--';
        document.getElementById('local-inventory-stats').style.display = 'block';

        renderLocalInventoryTable();

        document.getElementById('local-inventory-loading').style.display = 'none';
        document.getElementById('local-inventory-table').style.display = 'table';
        document.getElementById('local-inventory-pagination').style.display = 'flex';

      } catch (error) {
        console.error('Error loading local inventory:', error);
        document.getElementById('local-inventory-loading').innerHTML =
          `<span style="color: #dc2626;">Error: ${error.message}</span>`;
      }
    }

    function renderLocalInventoryTable() {
      const tbody = document.getElementById('local-inventory-body');
      const start = (localInventoryPage - 1) * localInventoryPageSize;
      const end = start + localInventoryPageSize;
      const pageItems = filteredLocalInventory.slice(start, end);

      tbody.innerHTML = pageItems.map(item => `
        <tr>
          <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; font-family: monospace; font-size: 11px;">${escapeHtml(item.store_code)}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; font-family: monospace; font-size: 10px;" title="${escapeHtml(item.itemid)}">${escapeHtml(item.itemid ? item.itemid.substring(0, 12) + '...' : '-')}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; font-weight: 600; ${item.quantity > 0 ? 'color: #16a34a;' : 'color: #dc2626;'}">${item.quantity}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; color: #6b7280; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.item_name || '')}">${escapeHtml(item.item_name || '-')}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${escapeHtml(item.variation_name || '-')}</td>
        </tr>
      `).join('');

      updateLocalInventoryPagination();
    }

    function updateLocalInventoryPagination() {
      const totalPages = Math.ceil(filteredLocalInventory.length / localInventoryPageSize) || 1;
      document.getElementById('li-page-info').textContent = `Page ${localInventoryPage} of ${totalPages} (${filteredLocalInventory.length} items)`;
      document.getElementById('li-prev-btn').disabled = localInventoryPage <= 1;
      document.getElementById('li-next-btn').disabled = localInventoryPage >= totalPages;
    }

    function prevLocalInventoryPage() {
      if (localInventoryPage > 1) {
        localInventoryPage--;
        renderLocalInventoryTable();
      }
    }

    function nextLocalInventoryPage() {
      const totalPages = Math.ceil(filteredLocalInventory.length / localInventoryPageSize);
      if (localInventoryPage < totalPages) {
        localInventoryPage++;
        renderLocalInventoryTable();
      }
    }

    function downloadLocalInventoryTsv() {
      const locationId = document.getElementById('local-inventory-location-select').value;
      if (!locationId) {
        alert('Please select a location first');
        return;
      }
      window.open(`/api/gmc/local-inventory-feed.tsv?location_id=${locationId}`, '_blank');
    }

    function renderLocationSettings() {
      const tbody = document.getElementById('location-settings-body');

      if (locationSettings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #6b7280;">No locations found. Sync your catalog first.</td></tr>';
        return;
      }

      tbody.innerHTML = locationSettings.map((loc, idx) => `
        <tr data-location-id="${loc.location_id}">
          <td>${escapeHtml(loc.location_name || 'Unknown')}</td>
          <td style="font-size: 12px; color: #6b7280;">${escapeHtml(loc.location_address || '-')}</td>
          <td>
            <input type="text" class="store-code-input" data-idx="${idx}"
                   value="${escapeHtml(loc.google_store_code || '')}"
                   placeholder="Enter store code...">
          </td>
          <td style="text-align: center;">
            <input type="checkbox" class="enabled-checkbox" data-idx="${idx}"
                   ${loc.enabled ? 'checked' : ''}>
          </td>
          <td>
            <button class="btn-save-row" data-action="saveLocationSettingFromButton" data-location-id="${escapeJsString(loc.location_id)}" data-idx="${idx}">Save</button>
          </td>
        </tr>
      `).join('');
    }

    async function saveLocationSetting(locationId, idx) {
      try {
        const row = document.querySelector(`tr[data-location-id="${locationId}"]`);
        const storeCodeInput = row.querySelector('.store-code-input');
        const enabledCheckbox = row.querySelector('.enabled-checkbox');

        const response = await fetch(`/api/gmc/location-settings/${locationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            google_store_code: storeCodeInput.value.trim(),
            enabled: enabledCheckbox.checked
          })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to save');

        // Update local data
        locationSettings[idx].google_store_code = storeCodeInput.value.trim();
        locationSettings[idx].enabled = enabledCheckbox.checked;

        // Visual feedback
        const btn = row.querySelector('.btn-save-row');
        btn.textContent = 'Saved!';
        btn.style.background = '#16a34a';
        setTimeout(() => {
          btn.textContent = 'Save';
          btn.style.background = '';
        }, 2000);
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Helper function for event delegation
    function saveLocationSettingFromButton(element) {
      const locationId = element.dataset.locationId;
      const idx = parseInt(element.dataset.idx, 10);
      saveLocationSetting(locationId, idx);
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      loadFeedData();
      loadFeedUrl();
      loadGmcSettings();
      loadFeedSettings();
      loadSyncStatus();
      loadLocalInventoryFeedUrl();
    });

    // Expose functions to global scope for event delegation
    window.switchTab = switchTab;
    window.toggleApiSettings = toggleApiSettings;
    window.saveGmcApiSettings = saveGmcApiSettings;
    window.testGmcConnection = testGmcConnection;
    window.toggleFeedSettings = toggleFeedSettings;
    window.saveFeedSettings = saveFeedSettings;
    window.syncProductsToGmc = syncProductsToGmc;
    window.openBrandManager = openBrandManager;
    window.openCategoryManager = openCategoryManager;
    window.closeBrandManager = closeBrandManager;
    window.detectBrands = detectBrands;
    window.applyBrands = applyBrands;
    window.closeCategoryManager = closeCategoryManager;
    window.setCategoryFilter = setCategoryFilter;
    window.importGoogleTaxonomy = importGoogleTaxonomy;
    window.removeCategoryMapping = removeCategoryMapping;
    window.assignTaxonomy = assignTaxonomy;
    window.downloadTsv = downloadTsv;
    window.exportCsv = exportCsv;
    window.prevPage = prevPage;
    window.nextPage = nextPage;
    window.copyLocalFeedUrl = copyLocalFeedUrl;
    window.downloadLocalInventoryTsv = downloadLocalInventoryTsv;
    window.prevLocalInventoryPage = prevLocalInventoryPage;
    window.nextLocalInventoryPage = nextLocalInventoryPage;
    window.loadSyncHistory = loadSyncHistory;
    window.saveLocationSettingFromButton = saveLocationSettingFromButton;
    window.selectCategory = selectCategory;
    window.selectTaxonomy = selectTaxonomy;
    window.toggleAllBrandsFromCheckbox = toggleAllBrandsFromCheckbox;
    window.loadLocalInventoryPreview = loadLocalInventoryPreview;
    window.updateSelectedCount = updateSelectedCount;
    window.filterCategories = filterCategories;
    window.filterTaxonomy = filterTaxonomy;
