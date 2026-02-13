/**
 * Label Printer Client - Zebra Browser Print Integration
 *
 * Handles communication with locally-connected Zebra printers via
 * Zebra Browser Print (a small agent running on the user's machine).
 *
 * Flow:
 * 1. Server generates ZPL from product data
 * 2. This module discovers local Zebra printers via Browser Print
 * 3. Sends ZPL directly to the printer
 *
 * Requires: Zebra Browser Print installed on the client machine
 * Download: https://www.zebra.com/us/en/support-downloads/printer-software/by-request-software.html
 */

const LabelPrinter = (function () {
    // Browser Print agent endpoints
    const BROWSER_PRINT_HTTP = 'http://127.0.0.1:9100';
    const BROWSER_PRINT_HTTPS = 'https://127.0.0.1:9101';
    let baseUrl = BROWSER_PRINT_HTTP;

    // State
    let selectedPrinter = null;
    let printerList = [];
    let isAvailable = null; // null = unchecked, true/false after check

    /**
     * Check if Zebra Browser Print agent is running.
     * Tries HTTP (9100) first, then HTTPS (9101).
     */
    async function checkAvailability() {
        // Try HTTP first
        try {
            const resp = await fetchWithTimeout(
                `${BROWSER_PRINT_HTTP}/available`,
                { method: 'GET' },
                3000
            );
            if (resp.ok) {
                baseUrl = BROWSER_PRINT_HTTP;
                isAvailable = true;
                console.log('[LabelPrinter] Zebra Browser Print detected on HTTP :9100');
                return true;
            }
        } catch (httpErr) {
            console.warn('[LabelPrinter] HTTP :9100 failed:', httpErr.message);
        }

        // Fall back to HTTPS
        try {
            const resp = await fetchWithTimeout(
                `${BROWSER_PRINT_HTTPS}/available`,
                { method: 'GET' },
                3000
            );
            if (resp.ok) {
                baseUrl = BROWSER_PRINT_HTTPS;
                isAvailable = true;
                console.log('[LabelPrinter] Zebra Browser Print detected on HTTPS :9101');
                return true;
            }
        } catch (httpsErr) {
            console.warn('[LabelPrinter] HTTPS :9101 failed:', httpsErr.message);
        }

        isAvailable = false;
        console.warn('[LabelPrinter] Zebra Browser Print not detected. Ensure the app is running on this PC.');
        return false;
    }

    /**
     * Discover locally connected Zebra printers
     */
    async function discoverPrinters() {
        if (isAvailable === null) {
            await checkAvailability();
        }
        if (!isAvailable) {
            return [];
        }

        try {
            const resp = await fetchWithTimeout(
                `${baseUrl}/available`,
                { method: 'GET' },
                5000
            );
            const data = await resp.json();

            printerList = [];

            // data.printer is the default printer (if any)
            // Some ZBP versions return a string, others return an object
            if (data.printer) {
                const defaultDevice = typeof data.printer === 'string'
                    ? { name: data.printer, uid: data.printer }
                    : data.printer;
                printerList.push(parsePrinter(defaultDevice, true));
            }

            // data.deviceList contains additional printers
            if (data.deviceList && Array.isArray(data.deviceList)) {
                for (const device of data.deviceList) {
                    if (device.name) {
                        printerList.push(parsePrinter(device, false));
                    }
                }
            }

            // Auto-select first printer if none selected
            if (!selectedPrinter && printerList.length > 0) {
                selectedPrinter = printerList[0];
            }

            return printerList;
        } catch (err) {
            console.error('Failed to discover printers:', err);
            return [];
        }
    }

    /**
     * Parse a printer object from Browser Print response
     */
    function parsePrinter(device, isDefault) {
        return {
            name: device.name || 'Unknown Printer',
            uid: device.uid || device.name,
            connection: device.connection || 'unknown',
            deviceType: device.deviceType || 'printer',
            provider: device.provider || '',
            manufacturer: device.manufacturer || '',
            isDefault: isDefault,
            version: device.version || 0
        };
    }

    /**
     * Select a printer by uid
     */
    function selectPrinter(uid) {
        selectedPrinter = printerList.find(p => p.uid === uid) || null;
        return selectedPrinter;
    }

    /**
     * Send raw ZPL to the selected printer
     */
    async function sendZpl(zpl, printer) {
        const target = printer || selectedPrinter;
        if (!target) {
            throw new Error('No printer selected');
        }

        const url = `${baseUrl}/write`;
        const resp = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({
                device: { name: target.name, uid: target.uid, connection: target.connection, deviceType: target.deviceType, provider: target.provider, manufacturer: target.manufacturer, version: target.version },
                data: zpl
            })
        }, 30000);

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Print failed: ${resp.status} ${text}`);
        }

        return true;
    }

    /**
     * Get printer status
     */
    async function getStatus(printer) {
        const target = printer || selectedPrinter;
        if (!target) {
            return null;
        }

        try {
            const url = `${baseUrl}/read`;
            // Send a Host Status Return command
            await sendZpl('~HS', target);

            const resp = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({
                    device: { name: target.name, uid: target.uid, connection: target.connection, deviceType: target.deviceType, provider: target.provider, manufacturer: target.manufacturer, version: target.version }
                })
            }, 5000);

            if (resp.ok) {
                return await resp.text();
            }
        } catch (_) {
            // Status read not supported or timed out
        }
        return null;
    }

    /**
     * High-level: Generate labels from server and print them
     *
     * @param {object} options
     * @param {string[]} options.variationIds - Variation IDs to print
     * @param {number} [options.templateId] - Template to use
     * @param {number} [options.copies] - Copies per label
     * @param {function} [options.onProgress] - Progress callback
     */
    async function printLabels(options) {
        const { variationIds, templateId, copies, onProgress } = options;

        if (onProgress) onProgress('Checking printer...');

        // Ensure printer is available
        if (isAvailable === null) {
            await checkAvailability();
        }
        if (!isAvailable) {
            throw new Error(
                'Zebra Browser Print is not running. Please install and start it.\n' +
                'Download from: zebra.com/browserprint'
            );
        }

        // Discover printers if needed
        if (!selectedPrinter) {
            if (onProgress) onProgress('Discovering printers...');
            await discoverPrinters();
        }
        if (!selectedPrinter) {
            throw new Error('No Zebra printer found. Check that your printer is connected and powered on.');
        }

        if (onProgress) onProgress('Generating labels...');

        // Fetch ZPL from server
        const resp = await fetch('/api/labels/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variationIds, templateId, copies })
        });

        const result = await resp.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to generate labels');
        }

        if (onProgress) onProgress(`Printing ${result.totalLabels} label(s) to ${selectedPrinter.name}...`);

        // Send to printer
        await sendZpl(result.zpl);

        return {
            printed: result.totalLabels,
            labelCount: result.labelCount,
            printer: selectedPrinter.name,
            template: result.template
        };
    }

    /**
     * High-level: Generate labels with override prices and print them
     *
     * @param {object} options
     * @param {Array<{variationId, newPriceCents}>} options.priceChanges
     * @param {number} [options.templateId]
     * @param {number} [options.copies]
     * @param {function} [options.onProgress]
     */
    async function printLabelsWithPrices(options) {
        const { priceChanges, templateId, copies, onProgress } = options;

        if (onProgress) onProgress('Checking printer...');

        if (isAvailable === null) {
            await checkAvailability();
        }
        if (!isAvailable) {
            throw new Error(
                'Zebra Browser Print is not running. Please install and start it.\n' +
                'Download from: zebra.com/browserprint'
            );
        }

        if (!selectedPrinter) {
            if (onProgress) onProgress('Discovering printers...');
            await discoverPrinters();
        }
        if (!selectedPrinter) {
            throw new Error('No Zebra printer found. Check that your printer is connected and powered on.');
        }

        if (onProgress) onProgress('Generating labels...');

        const resp = await fetch('/api/labels/generate-with-prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priceChanges, templateId, copies })
        });

        const result = await resp.json();
        if (!result.success) {
            throw new Error(result.error || 'Failed to generate labels');
        }

        if (onProgress) onProgress(`Printing ${result.totalLabels} label(s) to ${selectedPrinter.name}...`);

        await sendZpl(result.zpl);

        return {
            printed: result.totalLabels,
            labelCount: result.labelCount,
            printer: selectedPrinter.name,
            template: result.template
        };
    }

    /**
     * Render a printer selector dropdown.
     * If not yet detected, shows a retry button so the user can re-check
     * after starting Zebra Browser Print.
     */
    async function renderPrinterSelector(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // Re-check availability each time we render (ZBP may have started after page load)
        if (!isAvailable) {
            await checkAvailability();
            if (isAvailable) {
                await discoverPrinters();
            }
        }

        if (!isAvailable) {
            container.innerHTML =
                '<span style="color: #dc2626; font-size: 12px;">Zebra Browser Print not detected</span> ' +
                '<button id="retry-zbp-btn" style="padding: 2px 8px; font-size: 11px; border: 1px solid #d1d5db; border-radius: 3px; background: white; cursor: pointer; color: #4b5563;" title="Click after starting Zebra Browser Print on this PC">Retry</button>';
            const retryBtn = document.getElementById('retry-zbp-btn');
            if (retryBtn) {
                retryBtn.addEventListener('click', async function () {
                    retryBtn.disabled = true;
                    retryBtn.textContent = 'Checking...';
                    await checkAvailability();
                    if (isAvailable) {
                        await discoverPrinters();
                    }
                    await renderPrinterSelector(containerId);
                });
            }
            return;
        }

        if (printerList.length === 0) {
            container.innerHTML = '<span style="color: #d97706; font-size: 12px;">No printers found</span>';
            return;
        }

        let html = '<select id="label-printer-select" style="padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; background: white;">';
        printerList.forEach(p => {
            const selected = selectedPrinter && selectedPrinter.uid === p.uid ? 'selected' : '';
            const connType = p.connection ? ` (${p.connection})` : '';
            html += `<option value="${escapeAttr(p.uid)}" ${selected}>${escapeAttr(p.name)}${connType}</option>`;
        });
        html += '</select>';

        container.innerHTML = html;

        // Bind change handler
        const select = document.getElementById('label-printer-select');
        if (select) {
            select.addEventListener('change', function () {
                selectPrinter(this.value);
            });
        }
    }

    /**
     * Render a template selector dropdown
     */
    async function renderTemplateSelector(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        try {
            const resp = await fetch('/api/labels/templates');
            const data = await resp.json();

            if (!data.templates || data.templates.length === 0) {
                container.innerHTML = '<span style="color: #6b7280; font-size: 12px;">No templates configured</span>';
                return;
            }

            let html = '<select id="label-template-select" style="padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; background: white;">';
            data.templates.forEach(t => {
                const selected = t.is_default ? 'selected' : '';
                html += `<option value="${t.id}" ${selected}>${escapeAttr(t.name)} (${t.label_width_mm}x${t.label_height_mm}mm)</option>`;
            });
            html += '</select>';

            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = '<span style="color: #dc2626; font-size: 12px;">Failed to load templates</span>';
        }
    }

    /**
     * Get the currently selected template ID from the dropdown
     */
    function getSelectedTemplateId() {
        const select = document.getElementById('label-template-select');
        return select ? parseInt(select.value) : null;
    }

    // Utility: fetch with timeout
    function fetchWithTimeout(url, options, timeoutMs) {
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Request timed out'));
            }, timeoutMs || 10000);

            fetch(url, { ...options, signal: controller.signal })
                .then(resp => {
                    clearTimeout(timer);
                    resolve(resp);
                })
                .catch(err => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    // Utility: escape for HTML attributes
    function escapeAttr(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Public API
    return {
        checkAvailability,
        discoverPrinters,
        selectPrinter,
        sendZpl,
        getStatus,
        printLabels,
        printLabelsWithPrices,
        renderPrinterSelector,
        renderTemplateSelector,
        getSelectedTemplateId,
        isAvailable: function () { return isAvailable; },
        getSelectedPrinter: function () { return selectedPrinter; },
        getPrinters: function () { return printerList; }
    };
})();
