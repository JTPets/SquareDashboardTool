/**
 * Vendor Catalog Page JavaScript
 * Externalized from vendor-catalog.html for CSP compliance (P0-4)
 */

    // State for import flow
    let currentFileData = null;
    let currentFileName = null;
    let currentFileType = null;
    let previewData = null;
    let fieldTypes = [];
    let lastPriceReport = null; // Store last price report for export/viewing

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

        // Load data for specific tabs
        if (tab.dataset.tab === 'browse') {
          searchCatalog();
        } else if (tab.dataset.tab === 'batches') {
          loadBatches();
        }
      });
    });

    // Drag and drop
    const importBox = document.getElementById('import-box');

    importBox.addEventListener('dragover', (e) => {
      e.preventDefault();
      importBox.classList.add('dragover');
    });

    importBox.addEventListener('dragleave', () => {
      importBox.classList.remove('dragover');
    });

    importBox.addEventListener('drop', (e) => {
      e.preventDefault();
      importBox.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    // File input change
    document.getElementById('file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFile(file);
    });

    // Handle file selection - Step 1: Preview
    async function handleFile(file) {
      // Validate file type
      const validTypes = ['.csv', '.xlsx'];
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      if (!validTypes.includes(ext)) {
        alert('Please select a CSV or XLSX file');
        return;
      }

      // Show file info
      document.getElementById('file-info').style.display = 'block';
      document.getElementById('file-name').textContent = file.name;
      document.getElementById('file-size').textContent = ` (${formatBytes(file.size)})`;

      // Show preview progress
      document.getElementById('preview-progress').style.display = 'block';
      document.getElementById('import-result').classList.remove('show');

      try {
        // Read file as base64
        const base64 = await readFileAsBase64(file);
        currentFileData = base64;
        currentFileName = file.name;
        currentFileType = ext === '.xlsx' ? 'xlsx' : 'csv';

        // Call preview API
        const response = await fetch('/api/vendor-catalog/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: base64,
            fileName: file.name,
            fileType: currentFileType
          })
        });

        const result = await response.json();
        document.getElementById('preview-progress').style.display = 'none';

        if (!result.success) {
          showImportError(result.error || 'Failed to preview file');
          return;
        }

        previewData = result;

        // Show row count info
        document.getElementById('row-count-info').textContent =
          `Found ${result.totalRows} data rows.`;

        // Render the mapping table
        renderMappingTable(result.columns, result.autoMappings, result.sampleValues);

        // Populate vendor dropdown
        await populateImportVendorDropdown();

        // Switch to step 2
        document.getElementById('import-step-1').style.display = 'none';
        document.getElementById('import-step-2').style.display = 'block';

      } catch (error) {
        document.getElementById('preview-progress').style.display = 'none';
        showImportError(error.message);
      }
    }

    // Render the column mapping table with dropdowns
    function renderMappingTable(columns, autoMappings, sampleValues) {
      const tbody = document.getElementById('mapping-body');
      tbody.innerHTML = '';

      columns.forEach((col, index) => {
        const row = document.createElement('tr');

        // Original column header
        const headerCell = document.createElement('td');
        headerCell.style.fontWeight = '500';
        headerCell.textContent = col;
        row.appendChild(headerCell);

        // Dropdown for mapping
        const mapCell = document.createElement('td');
        const select = document.createElement('select');
        select.id = `mapping-${index}`;
        select.dataset.column = col;
        select.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px;';

        // Add field type options
        select.innerHTML = '<option value="skip">(Skip this column)</option>';
        fieldTypes.forEach(ft => {
          const option = document.createElement('option');
          option.value = ft.id;
          option.textContent = ft.label + (ft.required ? ' *' : '');
          if (autoMappings[col] === ft.id) {
            option.selected = true;
          }
          select.appendChild(option);
        });

        // Highlight auto-detected mappings
        if (autoMappings[col] && autoMappings[col] !== 'skip') {
          select.style.borderColor = '#10b981';
          select.style.backgroundColor = '#ecfdf5';
        }

        mapCell.appendChild(select);
        row.appendChild(mapCell);

        // Sample data
        const sampleCell = document.createElement('td');
        sampleCell.style.fontSize = '13px';
        sampleCell.style.color = '#6b7280';
        const samples = sampleValues[col] || [];
        sampleCell.innerHTML = samples.map((s, i) =>
          `<div style="padding: 2px 0; ${i > 0 ? 'border-top: 1px solid #e5e7eb;' : ''}">${escapeHtml(s || '(empty)')}</div>`
        ).join('');
        row.appendChild(sampleCell);

        tbody.appendChild(row);
      });
    }

    // Confirm and perform import - Step 2
    async function confirmImport() {
      // Validate vendor selection
      const vendorSelect = document.getElementById('import-vendor');
      const vendorId = vendorSelect.value;
      const vendorName = vendorSelect.options[vendorSelect.selectedIndex]?.text || '';

      if (!vendorId) {
        alert('Please select a vendor for this import');
        return;
      }

      // Gather mappings from dropdowns
      const mappings = {};
      const selects = document.querySelectorAll('[id^="mapping-"]');
      selects.forEach(select => {
        const value = select.value;
        if (value && value !== 'skip') {
          mappings[select.dataset.column] = value;
        }
      });

      // Validate required fields
      const mappedFields = Object.values(mappings);

      if (!mappedFields.includes('product_name')) {
        alert('Please map a column to Product Name (required)');
        return;
      }

      if (!mappedFields.includes('vendor_item_number')) {
        alert('Please map a column to Vendor Item # (required)');
        return;
      }

      if (!mappedFields.includes('cost')) {
        alert('Please map a column to Cost (required)');
        return;
      }

      // Show import progress
      document.getElementById('import-step-2').style.display = 'none';
      document.getElementById('import-progress').style.display = 'block';

      try {
        const importName = document.getElementById('import-name').value.trim();

        const response = await fetch('/api/vendor-catalog/import-mapped', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: currentFileData,
            fileName: currentFileName,
            fileType: currentFileType,
            mappings: mappings,
            vendorId: vendorId,
            vendorName: vendorName,
            importName: importName || null
          })
        });

        const result = await response.json();
        document.getElementById('import-progress').style.display = 'none';

        // Show result
        const resultEl = document.getElementById('import-result');
        resultEl.classList.add('show');

        if (result.success) {
          resultEl.classList.remove('error');
          resultEl.classList.add('success');
          document.getElementById('result-title').textContent = 'Import Successful!';

          let html = `
            <p><strong>Vendor:</strong> ${escapeHtml(result.vendorName)}</p>
            ${result.importName ? `<p><strong>Catalog:</strong> ${escapeHtml(result.importName)}</p>` : ''}
            <p><strong>${result.stats.imported}</strong> items imported</p>
            <p><strong>${result.stats.matched}</strong> items matched to our catalog</p>
          `;

          // Show price update report if there are differences
          if (result.stats.priceUpdatesCount > 0) {
            // Store for later export/viewing
            lastPriceReport = {
              vendorName: result.vendorName,
              importName: result.importName,
              batchId: result.batchId,
              importedAt: new Date().toISOString(),
              priceUpdates: result.stats.priceUpdates,
              summary: {
                total: result.stats.priceUpdatesCount,
                increases: result.stats.priceIncreasesCount,
                decreases: result.stats.priceDecreasesCount
              }
            };

            html += `
              <div style="margin-top: 15px; padding: 15px; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px;">
                <h4 style="color: #92400e; margin-bottom: 10px;">Price Update Report</h4>
                <p style="font-size: 14px; color: #78350f;">
                  <strong>${result.stats.priceUpdatesCount}</strong> items have price differences vs. our catalog
                  (${result.stats.priceIncreasesCount} increases, ${result.stats.priceDecreasesCount} decreases)
                </p>
                <p style="font-size: 13px; color: #78350f; margin-top: 5px;">
                  Check items below to mark them for price update in Square.
                </p>
                <div style="display: flex; gap: 10px; margin: 10px 0; flex-wrap: wrap; align-items: center;">
                  <button data-action="viewPriceReport" style="padding: 8px 16px; background: #1d4ed8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
                    View Full Report
                  </button>
                  <button data-action="downloadPriceReportCSV" style="padding: 8px 16px; background: #059669; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
                    Download CSV
                  </button>
                  <button id="push-to-square-btn" data-action="pushSelectedPricesToSquare" style="padding: 8px 16px; background: #7c3aed; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;" disabled>
                    Push Selected to Square (0)
                  </button>
                  <label style="display: flex; align-items: center; gap: 5px; font-size: 12px; color: #78350f; cursor: pointer; margin-left: 10px;">
                    <input type="checkbox" id="select-all-prices" data-change="toggleSelectAllPricesFromCheckbox" style="cursor: pointer;">
                    Select All
                  </label>
                </div>
                <div id="push-progress" style="display: none; margin: 10px 0; padding: 10px; background: #eff6ff; border-radius: 4px;">
                  <div class="spinner" style="width: 20px; height: 20px; border: 2px solid #dbeafe; border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; vertical-align: middle; margin-right: 10px;"></div>
                  <span id="push-progress-text">Pushing price changes to Square...</span>
                </div>
                <div id="push-result" style="display: none; margin: 10px 0; padding: 10px; border-radius: 4px;"></div>
                <div style="max-height: 300px; overflow-y: auto; margin-top: 10px;">
                  <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                    <thead>
                      <tr style="background: #fef08a;">
                        <th style="padding: 6px; text-align: center; width: 30px;">
                          <span title="Mark for Square update">Push</span>
                        </th>
                        <th style="padding: 6px; text-align: left;">Our SKU</th>
                        <th style="padding: 6px; text-align: left;">Item</th>
                        <th style="padding: 6px; text-align: right;">Our Price</th>
                        <th style="padding: 6px; text-align: right;">Vendor SRP</th>
                        <th style="padding: 6px; text-align: right;">Diff</th>
                      </tr>
                    </thead>
                    <tbody id="price-updates-body">
            `;
            result.stats.priceUpdates.forEach((p, idx) => {
              const diffColor = p.action === 'price_increase' ? '#059669' : '#dc2626';
              const diffSign = p.price_diff_cents > 0 ? '+' : '';
              const variationId = p.matched_variation_id || '';
              html += `
                <tr data-variation-id="${escapeHtml(variationId)}" data-new-price="${p.vendor_srp_cents}">
                  <td style="padding: 4px 6px; text-align: center;">
                    <input type="checkbox" class="price-update-checkbox"
                           data-variation-id="${escapeHtml(variationId)}"
                           data-new-price="${p.vendor_srp_cents}"
                           data-sku="${escapeHtml(p.our_sku || '')}"
                           data-item-name="${escapeHtml(p.our_item_name || p.product_name)}"
                           data-change="updatePushButtonCount"
                           ${!variationId ? 'disabled title="No matched variation"' : ''}
                           style="cursor: ${variationId ? 'pointer' : 'not-allowed'};">
                  </td>
                  <td style="padding: 4px 6px;"><code>${escapeHtml(p.our_sku || '-')}</code></td>
                  <td style="padding: 4px 6px;">${escapeHtml(p.our_item_name || p.product_name)}</td>
                  <td style="padding: 4px 6px; text-align: right;">${formatMoney(p.our_price_cents)}</td>
                  <td style="padding: 4px 6px; text-align: right;">${formatMoney(p.vendor_srp_cents)}</td>
                  <td style="padding: 4px 6px; text-align: right; color: ${diffColor}; font-weight: 600;">
                    ${diffSign}${formatMoney(p.price_diff_cents)} (${diffSign}${p.price_diff_percent.toFixed(1)}%)
                  </td>
                </tr>
              `;
            });
            html += '</tbody></table></div></div>';
          }

          if (result.validationErrors && result.validationErrors.length > 0) {
            html += `<p style="color: #d97706; margin-top: 10px;">${result.validationErrors.length} rows had validation errors and were skipped</p>`;
          }

          html += `<button data-action="resetImport" style="margin-top: 15px; padding: 10px 20px; background: #7c3aed; color: white; border: none; border-radius: 6px; cursor: pointer;">Import Another File</button>`;

          document.getElementById('result-content').innerHTML = html;

          // Inject label printer controls if price updates are showing
          if (result.stats.priceUpdatesCount > 0 && typeof LabelPrinter !== 'undefined') {
            injectPrinterControls('#result-content');
          }

          // Refresh stats
          loadStats();
        } else {
          showImportError(result.error, result.validationErrors);
        }

      } catch (error) {
        document.getElementById('import-progress').style.display = 'none';
        showImportError(error.message);
      }
    }

    // Show import error
    function showImportError(message, validationErrors) {
      const resultEl = document.getElementById('import-result');
      resultEl.classList.add('show', 'error');
      resultEl.classList.remove('success');
      document.getElementById('result-title').textContent = 'Import Failed';

      let html = `<p>${escapeHtml(message)}</p>`;
      if (validationErrors && validationErrors.length > 0) {
        html += '<ul style="margin-top: 10px; font-size: 13px;">';
        validationErrors.slice(0, 10).forEach(err => {
          html += `<li>Row ${err.row}: ${err.errors.join(', ')}</li>`;
        });
        if (validationErrors.length > 10) {
          html += `<li>...and ${validationErrors.length - 10} more errors</li>`;
        }
        html += '</ul>';
      }

      html += `<button data-action="resetImport" style="margin-top: 15px; padding: 10px 20px; background: #6b7280; color: white; border: none; border-radius: 6px; cursor: pointer;">Try Again</button>`;

      document.getElementById('result-content').innerHTML = html;
    }

    // Reset import to step 1
    function resetImport() {
      // Clear state
      currentFileData = null;
      currentFileName = null;
      currentFileType = null;
      previewData = null;

      // Reset UI
      document.getElementById('import-step-1').style.display = 'block';
      document.getElementById('import-step-2').style.display = 'none';
      document.getElementById('import-progress').style.display = 'none';
      document.getElementById('preview-progress').style.display = 'none';
      document.getElementById('import-result').classList.remove('show', 'success', 'error');
      document.getElementById('file-info').style.display = 'none';
      document.getElementById('file-input').value = '';
      document.getElementById('import-vendor').value = '';
      document.getElementById('import-name').value = '';
      document.getElementById('mapping-body').innerHTML = '';
    }

    // Populate import vendor dropdown
    async function populateImportVendorDropdown() {
      try {
        const response = await fetch('/api/vendors');
        const data = await response.json();

        const select = document.getElementById('import-vendor');
        // Clear existing options except first
        select.innerHTML = '<option value="">-- Select Vendor --</option>';

        data.vendors.forEach(vendor => {
          const option = document.createElement('option');
          option.value = vendor.id;
          option.textContent = vendor.name;
          select.appendChild(option);
        });
      } catch (error) {
        console.error('Failed to load vendors for import:', error);
      }
    }

    // Load field types for dropdowns
    async function loadFieldTypes() {
      try {
        const response = await fetch('/api/vendor-catalog/field-types');
        const data = await response.json();
        fieldTypes = data.fieldTypes || [];
      } catch (error) {
        console.error('Failed to load field types:', error);
        // Fallback field types
        fieldTypes = [
          { id: 'vendor_name', label: 'Vendor Name', required: false },
          { id: 'brand', label: 'Brand', required: false },
          { id: 'product_name', label: 'Product Name', required: true },
          { id: 'vendor_item_number', label: 'Vendor Item #', required: true },
          { id: 'upc', label: 'UPC/GTIN', required: false },
          { id: 'cost', label: 'Cost', required: true },
          { id: 'price', label: 'Price (SRP)', required: false }
        ];
      }
    }

    // Read file as base64
    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    // Format bytes
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // Format money
    function formatMoney(cents) {
      if (cents === null || cents === undefined) return '-';
      return '$' + (cents / 100).toFixed(2);
    }

    // Format margin
    function formatMargin(margin) {
      if (margin === null || margin === undefined) return '-';
      const marginClass = margin >= 40 ? 'good' : margin >= 25 ? 'warning' : 'bad';
      return `<span class="margin ${marginClass}">${margin.toFixed(1)}%</span>`;
    }

    // Load stats
    async function loadStats() {
      try {
        const response = await fetch('/api/vendor-catalog/stats');
        const stats = await response.json();

        document.getElementById('stat-total').textContent = stats.total_items?.toLocaleString() || '0';
        document.getElementById('stat-vendors').textContent = stats.vendor_count?.toLocaleString() || '0';
        document.getElementById('stat-matched').textContent = stats.matched_items?.toLocaleString() || '0';
        document.getElementById('stat-margin').textContent = stats.avg_margin ? stats.avg_margin.toFixed(1) + '%' : '-';
      } catch (error) {
        console.error('Failed to load stats:', error);
      }
    }

    // Load vendors for filter
    async function loadVendors() {
      try {
        const response = await fetch('/api/vendors');
        const data = await response.json();

        const select = document.getElementById('vendor-filter');
        data.vendors.forEach(vendor => {
          const option = document.createElement('option');
          option.value = vendor.id;
          option.textContent = vendor.name;
          select.appendChild(option);
        });
      } catch (error) {
        console.error('Failed to load vendors:', error);
      }
    }

    // Search catalog
    async function searchCatalog() {
      const search = document.getElementById('search-input').value;
      const vendorId = document.getElementById('vendor-filter').value;
      const matchFilter = document.getElementById('match-filter').value;

      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (vendorId) params.set('vendor_id', vendorId);
      if (matchFilter === 'true') params.set('matched_only', 'true');

      const tbody = document.getElementById('catalog-body');
      tbody.innerHTML = '<tr><td colspan="8" class="loading">Searching...</td></tr>';

      try {
        const response = await fetch('/api/vendor-catalog?' + params.toString());
        const data = await response.json();

        if (data.items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No items found</td></tr>';
          return;
        }

        tbody.innerHTML = data.items.map(item => `
          <tr>
            <td>${escapeHtml(item.vendor_name)}</td>
            <td><code>${escapeHtml(item.vendor_item_number)}</code></td>
            <td>${escapeHtml(item.product_name)}</td>
            <td>${item.upc ? `<code>${item.upc}</code>` : '-'}</td>
            <td class="money cost">${formatMoney(item.cost_cents)}</td>
            <td class="money price">${formatMoney(item.price_cents)}</td>
            <td>${formatMargin(parseFloat(item.margin_percent))}</td>
            <td>${item.matched_variation_id
              ? `<span class="badge badge-matched">Matched (${item.match_method})</span>`
              : '<span class="badge badge-unmatched">Unmatched</span>'}</td>
          </tr>
        `).join('');

      } catch (error) {
        tbody.innerHTML = `<tr><td colspan="8" class="error">Error: ${escapeHtml(error.message)}</td></tr>`;
      }
    }

    // Lookup UPC
    async function lookupUPC() {
      const upc = document.getElementById('lookup-upc').value.trim();
      if (!upc) {
        alert('Please enter a UPC');
        return;
      }

      const resultEl = document.getElementById('lookup-result');
      resultEl.innerHTML = '<div class="loading">Looking up...</div>';
      resultEl.classList.add('show');

      try {
        const response = await fetch(`/api/vendor-catalog/lookup/${encodeURIComponent(upc)}`);
        const data = await response.json();

        let html = '';

        // Our catalog item
        if (data.ourCatalogItem) {
          const item = data.ourCatalogItem;
          html += `
            <div class="lookup-card our-item" style="background: #ecfdf5; border-color: #10b981;">
              <h4 style="color: #059669;">Our Catalog Item</h4>
              <div class="lookup-details">
                <div class="lookup-detail">
                  <label>SKU</label>
                  <span>${item.sku || '-'}</span>
                </div>
                <div class="lookup-detail">
                  <label>Product</label>
                  <span>${escapeHtml(item.item_name || item.variation_name)}</span>
                </div>
                <div class="lookup-detail">
                  <label>Category</label>
                  <span>${escapeHtml(item.category_name || '-')}</span>
                </div>
                <div class="lookup-detail">
                  <label>Our Price</label>
                  <span class="price">${formatMoney(item.price_money)}</span>
                </div>
                <div class="lookup-detail">
                  <label>Current Cost</label>
                  <span class="cost">${formatMoney(item.current_cost_cents)}</span>
                </div>
              </div>
            </div>
          `;
        }

        // Vendor items
        if (data.vendorItems.length > 0) {
          html += '<h4 style="margin: 20px 0 10px; color: #374151;">Vendor Catalog Entries</h4>';
          data.vendorItems.forEach(item => {
            const margin = item.price_cents && item.cost_cents
              ? ((item.price_cents - item.cost_cents) / item.price_cents * 100).toFixed(1)
              : null;
            html += `
              <div class="lookup-card">
                <h4>${escapeHtml(item.vendor_name)}</h4>
                <div class="lookup-details">
                  <div class="lookup-detail">
                    <label>Vendor Item #</label>
                    <span>${escapeHtml(item.vendor_item_number)}</span>
                  </div>
                  <div class="lookup-detail">
                    <label>Product Name</label>
                    <span>${escapeHtml(item.product_name)}</span>
                  </div>
                  <div class="lookup-detail">
                    <label>Cost</label>
                    <span class="cost">${formatMoney(item.cost_cents)}</span>
                  </div>
                  <div class="lookup-detail">
                    <label>Suggested Price</label>
                    <span class="price">${formatMoney(item.price_cents)}</span>
                  </div>
                  ${margin ? `
                  <div class="lookup-detail">
                    <label>Margin</label>
                    <span>${formatMargin(parseFloat(margin))}</span>
                  </div>
                  ` : ''}
                </div>
              </div>
            `;
          });
        }

        if (!data.ourCatalogItem && data.vendorItems.length === 0) {
          html = `
            <div class="empty-state">
              <h3>No Results Found</h3>
              <p>No items found with UPC: ${escapeHtml(upc)}</p>
            </div>
          `;
        }

        resultEl.innerHTML = html;

      } catch (error) {
        resultEl.innerHTML = `<div class="error">Error: ${escapeHtml(error.message)}</div>`;
      }
    }

    // Load batches
    async function loadBatches(includeArchived = false) {
      const container = document.getElementById('batches-list');
      container.innerHTML = '<div class="loading">Loading batches...</div>';

      try {
        const url = includeArchived
          ? '/api/vendor-catalog/batches?include_archived=true'
          : '/api/vendor-catalog/batches';
        const response = await fetch(url);
        const data = await response.json();

        if (data.batches.length === 0) {
          container.innerHTML = `
            <div class="empty-state">
              <h3>No Import History</h3>
              <p>Import your first vendor catalog to see it here.</p>
            </div>
          `;
          return;
        }

        container.innerHTML = data.batches.map(batch => {
          const isArchived = batch.is_archived;
          const cardStyle = isArchived ? 'opacity: 0.6; background: #f3f4f6;' : '';

          return `
            <div class="batch-card" style="${cardStyle}">
              <div class="batch-info">
                <h4>
                  ${escapeHtml(batch.vendor_name)}
                  ${batch.import_name ? `<span style="font-weight: normal; color: #6b7280;"> - ${escapeHtml(batch.import_name)}</span>` : ''}
                  ${isArchived ? '<span style="font-size: 12px; color: #9ca3af; margin-left: 8px;">(Archived)</span>' : ''}
                </h4>
                <p style="font-size: 13px;">
                  Batch: <code style="font-size: 11px;">${batch.import_batch_id}</code><br>
                  Imported: ${new Date(batch.imported_at).toLocaleString()}
                </p>
              </div>
              <div class="batch-stats">
                <div class="batch-stat">
                  <div class="value">${batch.item_count}</div>
                  <div class="label">Items</div>
                </div>
                <div class="batch-stat">
                  <div class="value">${batch.matched_count}</div>
                  <div class="label">Matched</div>
                </div>
                <div class="batch-stat">
                  <div class="value">${batch.avg_margin ? parseFloat(batch.avg_margin).toFixed(1) + '%' : '-'}</div>
                  <div class="label">Avg Margin</div>
                </div>
                <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                  <button data-action="openBatchReport" data-action-param="${escapeJsString(batch.import_batch_id)}" style="padding: 8px 12px; background: #1d4ed8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">View Report</button>
                  ${isArchived
                    ? `<button data-action="unarchiveBatch" data-action-param="${escapeJsString(batch.import_batch_id)}" style="padding: 8px 12px; background: #dbeafe; color: #1d4ed8; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Restore</button>`
                    : `<button data-action="archiveBatch" data-action-param="${escapeJsString(batch.import_batch_id)}" style="padding: 8px 12px; background: #f3f4f6; color: #6b7280; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Archive</button>`
                  }
                  <button class="delete-btn" data-action="deleteBatch" data-action-param="${escapeJsString(batch.import_batch_id)}" style="font-size: 12px;">Delete</button>
                </div>
              </div>
            </div>
          `;
        }).join('');

      } catch (error) {
        container.innerHTML = `<div class="error">Error: ${escapeHtml(error.message)}</div>`;
      }
    }

    // Archive batch
    async function archiveBatch(element, event, param) {
      const batchId = param;
      if (!confirm(`Archive this import? It will be hidden but still searchable.`)) {
        return;
      }

      try {
        const response = await fetch(`/api/vendor-catalog/batches/${encodeURIComponent(batchId)}/archive`, {
          method: 'POST'
        });
        const result = await response.json();

        if (result.success) {
          const showArchived = document.getElementById('show-archived-checkbox')?.checked || false;
          loadBatches(showArchived);
          loadStats();
        } else {
          alert('Failed to archive batch: ' + result.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Unarchive batch
    async function unarchiveBatch(element, event, param) {
      const batchId = param;
      try {
        const response = await fetch(`/api/vendor-catalog/batches/${encodeURIComponent(batchId)}/unarchive`, {
          method: 'POST'
        });
        const result = await response.json();

        if (result.success) {
          const showArchived = document.getElementById('show-archived-checkbox')?.checked || false;
          loadBatches(showArchived);
          loadStats();
        } else {
          alert('Failed to unarchive batch: ' + result.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Delete batch
    async function deleteBatch(element, event, param) {
      const batchId = param;
      if (!confirm(`Permanently delete this import? This cannot be undone.`)) {
        return;
      }

      try {
        const response = await fetch(`/api/vendor-catalog/batches/${encodeURIComponent(batchId)}`, {
          method: 'DELETE'
        });
        const result = await response.json();

        if (result.success) {
          const showArchived = document.getElementById('show-archived-checkbox')?.checked || false;
          loadBatches(showArchived);
          loadStats();
        } else {
          alert('Failed to delete batch: ' + result.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Open price report for a batch from import history
    async function openBatchReport(element, event, param) {
      const batchId = param;
      try {
        const response = await fetch(`/api/vendor-catalog/batches/${encodeURIComponent(batchId)}/report`);
        const data = await response.json();

        if (!data.success) {
          alert('Failed to load report: ' + (data.error || 'Unknown error'));
          return;
        }

        // Store for export/viewing
        lastPriceReport = {
          vendorName: data.vendorName,
          importName: data.importName,
          batchId: data.batchId,
          importedAt: data.importedAt,
          priceUpdates: data.priceUpdates,
          summary: data.summary
        };

        // Switch to Import tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.tab[data-tab="import"]').classList.add('active');
        document.getElementById('tab-import').classList.add('active');

        // Hide import steps and show result container
        document.getElementById('import-step-1').style.display = 'none';
        document.getElementById('import-step-2').style.display = 'none';
        document.getElementById('import-progress').style.display = 'none';

        const resultContainer = document.getElementById('import-result');
        resultContainer.className = 'import-result show success';

        // Build result HTML
        const priceUpdates = data.priceUpdates;
        let html = `
          <div style="margin-bottom: 15px;">
            <strong>Vendor:</strong> ${escapeHtml(data.vendorName)}
            ${data.importName ? ` - <em>${escapeHtml(data.importName)}</em>` : ''}
            <br>
            <span style="font-size: 12px; color: #6b7280;">
              Originally imported: ${new Date(data.importedAt).toLocaleString()}
              | ${data.totalItems} items (${data.matchedItems} matched)
            </span>
          </div>
        `;

        if (priceUpdates.length > 0) {
          html += `
            <div style="margin-top: 15px; padding: 15px; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px;">
              <h4 style="color: #92400e; margin-bottom: 10px;">Price Update Report</h4>
              <p style="font-size: 14px; color: #78350f;">
                <strong>${priceUpdates.length}</strong> items have price differences vs. current catalog
                (${data.summary.increases} increases, ${data.summary.decreases} decreases)
              </p>
              <p style="font-size: 13px; color: #78350f; margin-top: 5px;">
                Check items below to mark them for price update in Square.
              </p>
              <div style="display: flex; gap: 10px; margin: 10px 0; flex-wrap: wrap; align-items: center;">
                <button data-action="viewPriceReport" style="padding: 8px 16px; background: #1d4ed8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
                  View Full Report
                </button>
                <button data-action="downloadPriceReportCSV" style="padding: 8px 16px; background: #059669; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
                  Download CSV
                </button>
                <button id="push-to-square-btn" data-action="pushSelectedPricesToSquare" style="padding: 8px 16px; background: #7c3aed; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;" disabled>
                  Push Selected to Square (0)
                </button>
                <label style="display: flex; align-items: center; gap: 5px; font-size: 12px; color: #78350f; cursor: pointer; margin-left: 10px;">
                  <input type="checkbox" id="select-all-prices" data-change="toggleSelectAllPricesFromCheckbox" style="cursor: pointer;">
                  Select All
                </label>
              </div>
              <div id="push-progress" style="display: none; margin: 10px 0; padding: 10px; background: #eff6ff; border-radius: 4px;">
                <div class="spinner" style="width: 20px; height: 20px; border: 2px solid #dbeafe; border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; vertical-align: middle; margin-right: 10px;"></div>
                <span id="push-progress-text">Pushing price changes to Square...</span>
              </div>
              <div id="push-result" style="display: none; margin: 10px 0; padding: 10px; border-radius: 4px;"></div>
              <div style="max-height: 300px; overflow-y: auto; margin-top: 10px;">
                <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                  <thead>
                    <tr style="background: #fef08a;">
                      <th style="padding: 6px; text-align: center; width: 30px;">
                        <span title="Mark for Square update">Push</span>
                      </th>
                      <th style="padding: 6px; text-align: left;">Our SKU</th>
                      <th style="padding: 6px; text-align: left;">Item</th>
                      <th style="padding: 6px; text-align: right;">Our Price</th>
                      <th style="padding: 6px; text-align: right;">Vendor SRP</th>
                      <th style="padding: 6px; text-align: right;">Diff</th>
                    </tr>
                  </thead>
                  <tbody id="price-updates-body">
          `;

          priceUpdates.forEach((p, idx) => {
            const diffColor = p.action === 'price_increase' ? '#059669' : '#dc2626';
            const diffSign = p.price_diff_cents > 0 ? '+' : '';
            const variationId = p.matched_variation_id || '';
            html += `
              <tr data-variation-id="${escapeHtml(variationId)}" data-new-price="${p.vendor_srp_cents}">
                <td style="padding: 4px 6px; text-align: center;">
                  <input type="checkbox" class="price-update-checkbox"
                         data-variation-id="${escapeHtml(variationId)}"
                         data-new-price="${p.vendor_srp_cents}"
                         data-sku="${escapeHtml(p.our_sku || '')}"
                         data-item-name="${escapeHtml(p.our_item_name || p.product_name)}"
                         data-change="updatePushButtonCount"
                         ${!variationId ? 'disabled title="No matched variation"' : ''}
                         style="cursor: ${variationId ? 'pointer' : 'not-allowed'};">
                </td>
                <td style="padding: 4px 6px;"><code>${escapeHtml(p.our_sku || '-')}</code></td>
                <td style="padding: 4px 6px;">${escapeHtml(p.our_item_name || p.product_name)}</td>
                <td style="padding: 4px 6px; text-align: right;">${formatMoney(p.our_price_cents)}</td>
                <td style="padding: 4px 6px; text-align: right;">${formatMoney(p.vendor_srp_cents)}</td>
                <td style="padding: 4px 6px; text-align: right; color: ${diffColor}; font-weight: 600;">
                  ${diffSign}${formatMoney(p.price_diff_cents)} (${diffSign}${p.price_diff_percent.toFixed(1)}%)
                </td>
              </tr>
            `;
          });
          html += '</tbody></table></div></div>';
        } else {
          html += `
            <div style="margin-top: 15px; padding: 15px; background: #d1fae5; border: 1px solid #10b981; border-radius: 6px;">
              <p style="color: #065f46;">No price differences found. All matched items are within 1% of current catalog prices.</p>
            </div>
          `;
        }

        html += `<button data-action="resetImport" style="margin-top: 15px; padding: 10px 20px; background: #7c3aed; color: white; border: none; border-radius: 6px; cursor: pointer;">Back to Import</button>`;

        document.getElementById('result-title').textContent = 'Price Report';
        document.getElementById('result-content').innerHTML = html;

        // Inject label printer controls if price updates are showing
        if (priceUpdates.length > 0 && typeof LabelPrinter !== 'undefined') {
          injectPrinterControls('#result-content');
        }

      } catch (error) {
        alert('Error loading report: ' + error.message);
      }
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

    // --- Event delegation helper functions ---

    // Trigger file input click (for data-action handler)
    function triggerFileInput() {
      document.getElementById('file-input').click();
    }

    // Lookup UPC on Enter key (for data-keydown handler)
    function lookupUPCOnEnter(element, event) {
      if (event.key === 'Enter') {
        lookupUPC();
      }
    }

    // Search catalog on Enter key (for data-keydown handler)
    function searchCatalogOnEnter(element, event) {
      if (event.key === 'Enter') {
        searchCatalog();
      }
    }

    // Load batches from checkbox (for data-change handler)
    function loadBatchesFromCheckbox(element) {
      loadBatches(element.checked);
    }

    // Toggle select all prices from checkbox (for data-change handler)
    function toggleSelectAllPricesFromCheckbox(element) {
      toggleSelectAllPrices(element.checked);
    }

    // Print report (for data-action handler)
    function printReport() {
      window.print();
    }

    // View price report in new window (from last import)
    function viewPriceReport() {
      if (!lastPriceReport || !lastPriceReport.priceUpdates.length) {
        alert('No price report available');
        return;
      }
      openReportWindow(lastPriceReport);
    }

    // Open price report window with given report data
    function openReportWindow(report) {
      if (!report || !report.priceUpdates || !report.priceUpdates.length) {
        alert('No price differences found in this import');
        return;
      }

      const reportWindow = window.open('', '_blank', 'width=1200,height=800');

      let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Price Update Report - ${escapeHtml(report.vendorName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f9fafb; }
    .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header h1 { margin: 0 0 10px 0; color: #374151; }
    .header p { margin: 5px 0; color: #6b7280; }
    .summary { display: flex; gap: 20px; margin-top: 15px; }
    .summary-stat { background: #fef3c7; padding: 10px 20px; border-radius: 6px; text-align: center; }
    .summary-stat .value { font-size: 24px; font-weight: bold; color: #92400e; }
    .summary-stat .label { font-size: 12px; color: #78350f; }
    .actions { margin-top: 15px; }
    .actions button { padding: 10px 20px; margin-right: 10px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .btn-csv { background: #059669; color: white; }
    .btn-print { background: #6b7280; color: white; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #f3f4f6; padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; }
    td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    tr:hover { background: #f9fafb; }
    .increase { color: #059669; font-weight: 600; }
    .decrease { color: #dc2626; font-weight: 600; }
    .right { text-align: right; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    @media print { .actions { display: none; } body { background: white; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>Price Update Report</h1>
    <p><strong>Vendor:</strong> ${escapeHtml(report.vendorName)}</p>
    ${report.importName ? `<p><strong>Catalog:</strong> ${escapeHtml(report.importName)}</p>` : ''}
    <p><strong>Generated:</strong> ${new Date(report.importedAt).toLocaleString()}</p>
    <div class="summary">
      <div class="summary-stat">
        <div class="value">${report.summary.total}</div>
        <div class="label">Total Differences</div>
      </div>
      <div class="summary-stat">
        <div class="value" style="color: #059669;">${report.summary.increases}</div>
        <div class="label">Price Increases</div>
      </div>
      <div class="summary-stat">
        <div class="value" style="color: #dc2626;">${report.summary.decreases}</div>
        <div class="label">Price Decreases</div>
      </div>
    </div>
    <div class="actions">
      <button class="btn-csv" data-action="downloadCSV">Download CSV</button>
      <button class="btn-print" data-action="printReport">Print Report</button>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Our SKU</th>
        <th>Item Name</th>
        <th>UPC</th>
        <th>Vendor Item #</th>
        <th class="right">Our Price</th>
        <th class="right">Vendor SRP</th>
        <th class="right">Vendor Cost</th>
        <th class="right">Difference</th>
        <th>Match</th>
      </tr>
    </thead>
    <tbody>
      `;

      report.priceUpdates.forEach(p => {
        const diffClass = p.action === 'price_increase' ? 'increase' : 'decrease';
        const diffSign = p.price_diff_cents > 0 ? '+' : '';
        html += `
      <tr>
        <td><code>${escapeHtml(p.our_sku || '-')}</code></td>
        <td>${escapeHtml(p.our_item_name || p.product_name)}</td>
        <td><code>${escapeHtml(p.upc || '-')}</code></td>
        <td><code>${escapeHtml(p.vendor_item_number)}</code></td>
        <td class="right">$${(p.our_price_cents / 100).toFixed(2)}</td>
        <td class="right">$${(p.vendor_srp_cents / 100).toFixed(2)}</td>
        <td class="right">$${(p.vendor_cost_cents / 100).toFixed(2)}</td>
        <td class="right ${diffClass}">${diffSign}$${(p.price_diff_cents / 100).toFixed(2)} (${diffSign}${p.price_diff_percent.toFixed(1)}%)</td>
        <td>${p.match_method || '-'}</td>
      </tr>
        `;
      });

      html += `
    </tbody>
  </table>
  <script data-cfasync="false">
    const reportData = ${JSON.stringify(report.priceUpdates)};
    function downloadCSV() {
      const headers = ['Our SKU','Item Name','UPC','Vendor Item #','Our Price','Vendor SRP','Vendor Cost','Diff ($)','Diff (%)','Match Method'];
      const rows = reportData.map(p => [
        p.our_sku || '',
        '"' + (p.our_item_name || p.product_name || '').replace(/"/g, '""') + '"',
        p.upc || '',
        p.vendor_item_number || '',
        (p.our_price_cents / 100).toFixed(2),
        (p.vendor_srp_cents / 100).toFixed(2),
        (p.vendor_cost_cents / 100).toFixed(2),
        (p.price_diff_cents / 100).toFixed(2),
        p.price_diff_percent.toFixed(1),
        p.match_method || ''
      ]);
      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'price-update-report.csv';
      a.click();
      URL.revokeObjectURL(url);
    }
  <\/script>
</body>
</html>
      `;

      reportWindow.document.write(html);
      reportWindow.document.close();
    }

    // Update push button count
    function updatePushButtonCount() {
      const checkboxes = document.querySelectorAll('.price-update-checkbox:checked');
      const btn = document.getElementById('push-to-square-btn');
      if (btn) {
        btn.textContent = `Push Selected to Square (${checkboxes.length})`;
        btn.disabled = checkboxes.length === 0;
      }
      // Also update print button count
      updatePrintButtonCount();
    }

    // Toggle select all price checkboxes
    function toggleSelectAllPrices(checked) {
      const checkboxes = document.querySelectorAll('.price-update-checkbox:not(:disabled)');
      checkboxes.forEach(cb => {
        cb.checked = checked;
      });
      updatePushButtonCount();
    }

    // Push selected price changes to Square
    async function pushSelectedPricesToSquare() {
      const checkboxes = document.querySelectorAll('.price-update-checkbox:checked');
      if (checkboxes.length === 0) {
        alert('Please select at least one item to push to Square');
        return;
      }

      // Confirm action
      const confirmMsg = `Are you sure you want to update ${checkboxes.length} item price(s) in Square?\n\nThis will change the retail prices in your Square catalog.`;
      if (!confirm(confirmMsg)) {
        return;
      }

      // Build price changes array
      const priceChanges = [];
      checkboxes.forEach(cb => {
        const variationId = cb.dataset.variationId;
        const newPriceCents = parseInt(cb.dataset.newPrice);
        if (variationId && !isNaN(newPriceCents)) {
          priceChanges.push({
            variationId,
            newPriceCents,
            currency: 'CAD'
          });
        }
      });

      if (priceChanges.length === 0) {
        alert('No valid price changes to push');
        return;
      }

      // Show progress
      const progressEl = document.getElementById('push-progress');
      const resultEl = document.getElementById('push-result');
      const btn = document.getElementById('push-to-square-btn');

      progressEl.style.display = 'block';
      resultEl.style.display = 'none';
      btn.disabled = true;

      try {
        const response = await fetch('/api/vendor-catalog/push-price-changes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priceChanges })
        });

        const result = await response.json();
        progressEl.style.display = 'none';

        if (result.success) {
          resultEl.style.display = 'block';
          resultEl.style.background = '#ecfdf5';
          resultEl.style.border = '1px solid #10b981';
          resultEl.innerHTML = `
            <strong style="color: #059669;">Success!</strong>
            <span style="color: #065f46;"> ${result.updated} price(s) updated in Square.</span>
          `;

          // Uncheck the successfully updated items and disable them
          checkboxes.forEach(cb => {
            const detailEntry = result.details?.find(d => d.variationId === cb.dataset.variationId);
            if (detailEntry && detailEntry.success) {
              cb.checked = false;
              cb.disabled = true;
              cb.parentElement.parentElement.style.opacity = '0.5';
              cb.parentElement.parentElement.style.textDecoration = 'line-through';
            }
          });

          updatePushButtonCount();
        } else {
          resultEl.style.display = 'block';
          resultEl.style.background = '#fef2f2';
          resultEl.style.border = '1px solid #ef4444';

          let errorHtml = `<strong style="color: #dc2626;">Error:</strong> <span style="color: #991b1b;">${escapeHtml(result.error || 'Unknown error')}</span>`;

          if (result.updated > 0) {
            errorHtml = `
              <strong style="color: #d97706;">Partial Success:</strong>
              <span style="color: #92400e;"> ${result.updated} updated, ${result.failed} failed.</span>
            `;
          }

          if (result.errors && result.errors.length > 0) {
            errorHtml += '<ul style="margin-top: 5px; font-size: 12px; color: #991b1b;">';
            result.errors.slice(0, 5).forEach(err => {
              errorHtml += `<li>${escapeHtml(err.variationId || `Batch ${err.batch}`)}: ${escapeHtml(err.error)}</li>`;
            });
            if (result.errors.length > 5) {
              errorHtml += `<li>...and ${result.errors.length - 5} more errors</li>`;
            }
            errorHtml += '</ul>';
          }

          resultEl.innerHTML = errorHtml;
          btn.disabled = false;
        }
      } catch (error) {
        progressEl.style.display = 'none';
        resultEl.style.display = 'block';
        resultEl.style.background = '#fef2f2';
        resultEl.style.border = '1px solid #ef4444';
        resultEl.innerHTML = `<strong style="color: #dc2626;">Error:</strong> <span style="color: #991b1b;">${escapeHtml(error.message)}</span>`;
        btn.disabled = false;
      }
    }

    // Download price report as CSV
    function downloadPriceReportCSV() {
      if (!lastPriceReport || !lastPriceReport.priceUpdates.length) {
        alert('No price report available');
        return;
      }

      const report = lastPriceReport;
      const headers = ['Our SKU','Item Name','UPC','Vendor Item #','Our Price','Vendor SRP','Vendor Cost','Diff ($)','Diff (%)','Match Method','Action'];

      const rows = report.priceUpdates.map(p => [
        p.our_sku || '',
        '"' + (p.our_item_name || p.product_name || '').replace(/"/g, '""') + '"',
        p.upc || '',
        p.vendor_item_number || '',
        (p.our_price_cents / 100).toFixed(2),
        (p.vendor_srp_cents / 100).toFixed(2),
        (p.vendor_cost_cents / 100).toFixed(2),
        (p.price_diff_cents / 100).toFixed(2),
        p.price_diff_percent.toFixed(1),
        p.match_method || '',
        p.action || ''
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `price-report-${report.vendorName.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

    // ===== Label Printing Integration =====

    // Initialize label printer on page load (non-blocking)
    async function initLabelPrinter() {
      const available = await LabelPrinter.checkAvailability();
      if (available) {
        await LabelPrinter.discoverPrinters();
      }
    }

    // Inject the printer controls bar into the price report actions area
    function injectPrinterControls(parentSelector) {
      const existing = document.getElementById('label-printer-bar');
      if (existing) existing.remove();

      const bar = document.createElement('div');
      bar.id = 'label-printer-bar';
      bar.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-top: 10px; padding: 10px; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; flex-wrap: wrap;';

      bar.innerHTML = `
        <span style="font-size: 12px; font-weight: 600; color: #0369a1;">Print Labels:</span>
        <span id="printer-selector-container" style="font-size: 12px;"></span>
        <span id="template-selector-container" style="font-size: 12px;"></span>
        <button id="print-selected-labels-btn" data-action="printSelectedLabels" style="padding: 6px 14px; background: #0284c7; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;" disabled>
          Print Selected (0)
        </button>
        <div id="print-progress" style="display: none; font-size: 12px; color: #0369a1;"></div>
        <div id="print-result" style="display: none; font-size: 12px; padding: 4px 8px; border-radius: 4px;"></div>
      `;

      // Insert after the push-result div if it exists, otherwise after the actions bar
      const pushResult = document.getElementById('push-result');
      if (pushResult && pushResult.parentElement) {
        pushResult.parentElement.insertBefore(bar, pushResult.nextSibling);
      } else {
        const parent = document.querySelector(parentSelector);
        if (parent) parent.appendChild(bar);
      }

      // Populate dropdowns
      LabelPrinter.renderPrinterSelector('printer-selector-container');
      LabelPrinter.renderTemplateSelector('template-selector-container');

      // Update print button count
      updatePrintButtonCount();
    }

    // Update the print button count based on checked checkboxes
    function updatePrintButtonCount() {
      const btn = document.getElementById('print-selected-labels-btn');
      if (!btn) return;
      const checkboxes = document.querySelectorAll('.price-update-checkbox:checked');
      btn.textContent = `Print Selected (${checkboxes.length})`;
      btn.disabled = checkboxes.length === 0;
    }

    // Print labels for the selected price update items
    async function printSelectedLabels() {
      const checkboxes = document.querySelectorAll('.price-update-checkbox:checked');
      if (checkboxes.length === 0) {
        alert('Please select at least one item to print labels for');
        return;
      }

      const priceChanges = [];
      checkboxes.forEach(cb => {
        const variationId = cb.dataset.variationId;
        const newPriceCents = parseInt(cb.dataset.newPrice);
        if (variationId && !isNaN(newPriceCents)) {
          priceChanges.push({ variationId, newPriceCents });
        }
      });

      if (priceChanges.length === 0) {
        alert('No valid items selected for label printing');
        return;
      }

      const progressEl = document.getElementById('print-progress');
      const resultEl = document.getElementById('print-result');
      const btn = document.getElementById('print-selected-labels-btn');

      if (progressEl) progressEl.style.display = 'inline';
      if (resultEl) resultEl.style.display = 'none';
      if (btn) btn.disabled = true;

      try {
        const templateId = LabelPrinter.getSelectedTemplateId();
        const result = await LabelPrinter.printLabelsWithPrices({
          priceChanges,
          templateId,
          copies: 1,
          onProgress: function (msg) {
            if (progressEl) progressEl.textContent = msg;
          }
        });

        if (progressEl) progressEl.style.display = 'none';
        if (resultEl) {
          resultEl.style.display = 'inline';
          resultEl.style.background = '#dcfce7';
          resultEl.style.color = '#166534';
          resultEl.textContent = `Printed ${result.printed} label(s) to ${result.printer}`;
        }
      } catch (err) {
        if (progressEl) progressEl.style.display = 'none';
        if (resultEl) {
          resultEl.style.display = 'inline';
          resultEl.style.background = '#fef2f2';
          resultEl.style.color = '#991b1b';
          resultEl.textContent = err.message;
        }
      }

      if (btn) btn.disabled = false;
      updatePrintButtonCount();
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      loadStats();
      loadVendors();
      loadFieldTypes();
      initLabelPrinter();
    });

    // Expose functions to global scope for event delegation
    window.triggerFileInput = triggerFileInput;
    window.resetImport = resetImport;
    window.confirmImport = confirmImport;
    window.lookupUPC = lookupUPC;
    window.searchCatalog = searchCatalog;
    window.viewPriceReport = viewPriceReport;
    window.downloadPriceReportCSV = downloadPriceReportCSV;
    window.pushSelectedPricesToSquare = pushSelectedPricesToSquare;
    window.openBatchReport = openBatchReport;
    window.unarchiveBatch = unarchiveBatch;
    window.archiveBatch = archiveBatch;
    window.deleteBatch = deleteBatch;
    window.printReport = printReport;
    window.lookupUPCOnEnter = lookupUPCOnEnter;
    window.searchCatalogOnEnter = searchCatalogOnEnter;
    window.loadBatchesFromCheckbox = loadBatchesFromCheckbox;
    window.toggleSelectAllPricesFromCheckbox = toggleSelectAllPricesFromCheckbox;
    window.updatePushButtonCount = updatePushButtonCount;
    window.printSelectedLabels = printSelectedLabels;
