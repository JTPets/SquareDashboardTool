# Event Delegation Pattern & JavaScript Rules

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

All HTML files use event delegation for CSP compliance. **This is critical - failures are SILENT (no console errors, elements just don't respond).**

---

## Supported Event Attributes

| Attribute | Replaces | Example |
|-----------|----------|---------|
| `data-action` | `onclick` | `<button data-action="save">` |
| `data-change` | `onchange` | `<select data-change="filter">` |
| `data-blur` | `onblur` | `<input data-blur="saveField">` |
| `data-input` | `oninput` | `<input data-input="search">` |
| `data-keydown` | `onkeydown` | `<input data-keydown="handleKey">` |
| `data-keyup` | `onkeyup` | `<input data-keyup="handleKeyup">` |
| `data-submit` | `onsubmit` | `<form data-submit="handleForm">` |
| `data-focus` | `onfocus` | `<input data-focus="handleFocus">` |

---

## Required Pattern

### HTML: Use data attributes, NOT inline handlers

```html
<button data-action="saveItem" data-action-param="123">Save</button>
<input data-blur="validateField" data-change="updatePreview">
<select data-change="filterResults">
```

### JavaScript: Define functions with CORRECT parameter order

```javascript
// CRITICAL: Parameter order is ALWAYS (element, event, param)
function saveItem(element, event, param) {
  // element = the DOM element that triggered the event
  // event = the DOM event object
  // param = value from data-action-param attribute
}
function validateField(element, event) { /* ... */ }
function filterResults(element, event) { /* ... */ }

// CRITICAL: Export ALL handler functions to window at end of script
window.saveItem = saveItem;
window.validateField = validateField;
window.filterResults = filterResults;
```

---

## Handler Function Signature

**All event delegation handlers MUST use this parameter order:**
```javascript
function handlerName(element, event, param) { ... }
```
- `element` - The DOM element that triggered the event
- `event` - The DOM event object (click, change, blur, etc.)
- `param` - The value from `data-action-param` attribute (optional)

**Common mistake:** Writing `function handler(param, element, event)` - this is WRONG and will cause silent failures because element will be undefined when accessing `element.dataset.*`.

---

## Dynamically Created Elements

When creating elements in JavaScript, use data attributes - NEVER use `.onclick`:

```javascript
// WRONG - CSP blocks this, fails silently
const btn = document.createElement('button');
btn.onclick = function() { doSomething(); };  // BLOCKED BY CSP

// CORRECT - Works with event delegation
const btn = document.createElement('button');
btn.dataset.action = 'doSomething';           // CSP compliant
btn.dataset.actionParam = '123';              // Optional param
```

---

## Pre-Commit Checklist

Before committing changes to HTML files:
- [ ] All interactive elements use `data-*` attributes (no `onclick`, `onchange`, etc.)
- [ ] All functions referenced in `data-*` attributes are exported to `window`
- [ ] **All functions exported to `window` actually exist** (see warning below)
- [ ] Handler functions use correct parameter order: `(element, event, param)`
- [ ] Dynamically created elements use `dataset.*` not `.onclick`/`.onchange`
- [ ] Test that ALL buttons/inputs actually respond to clicks/changes

---

## Window Export Errors Crash Everything

```javascript
// DANGEROUS - If functionName doesn't exist, this crashes the ENTIRE script
window.functionName = functionName;  // ReferenceError stops execution here!
window.saveField = saveField;        // This line NEVER RUNS
window.enterEditMode = enterEditMode; // This line NEVER RUNS
// Nothing works, but page loads and looks normal!

// SAFE - Verify function exists, or just don't export non-existent functions
if (typeof functionName === 'function') {
  window.functionName = functionName;
}
```

**Rule:** Never export a function to `window` unless you've verified the function is defined in the same script. A single bad export breaks ALL functionality silently.

---

## Debugging Silent Failures

If an element doesn't respond:
1. Open browser console - **look for ReferenceError or other red errors first**
2. Check: `typeof window.functionName` - should be `"function"`, not `"undefined"`
3. If undefined, either the function doesn't exist OR an earlier export crashed the script

See `/public/js/event-delegation.js` for implementation.

**Audit command** for undefined exports:
```bash
for file in public/*.html; do
  grep "window\.[a-zA-Z]* = [a-zA-Z]*;" "$file" | while read line; do
    func=$(echo "$line" | sed -n 's/.*window\.\([a-zA-Z_]*\) = \1;.*/\1/p')
    if [ -n "$func" ] && ! grep -q "function $func" "$file"; then
      echo "ERROR: $(basename $file) - '$func' exported but not defined"
    fi
  done
done
```

---

## JavaScript Execution Rules (App-Agnostic)

These rules apply to any web application with inline scripts:

### 1. Script Errors Are Fatal to Everything Below

```javascript
// If line 10 throws an error, lines 11+ NEVER execute
doSomething();           // Line 10: ReferenceError if undefined
window.a = a;            // Line 11: Never runs
window.b = b;            // Line 12: Never runs
initializeApp();         // Line 13: Never runs - app appears broken
```

**Rule:** Errors don't just skip the bad line - they terminate the entire script block. Always check browser console for red errors first.

### 2. Reference Before Definition = Crash

```javascript
// WRONG - Using before defining crashes immediately
window.myFunc = myFunc;  // ReferenceError: myFunc is not defined
function myFunc() {}     // Too late!

// CORRECT - Define before using
function myFunc() {}
window.myFunc = myFunc;  // Works
```

### 3. Silent vs Loud Failures

| Pattern | Failure Mode | How to Debug |
|---------|--------------|--------------|
| Missing function export | Silent - UI doesn't respond | `typeof window.func` |
| ReferenceError in exports | Silent - all exports after it fail | Browser console (red) |
| CSP-blocked inline handler | Silent - no error shown | Check CSP headers |
| API call failure | May be silent if no error UI | Network tab |
| Typo in data attribute | Silent - handler never called | Inspect element |

### 4. Export Ordering Pattern

Always structure inline scripts in this order:
```javascript
<script>
  // 1. Constants and state
  const state = {};

  // 2. All function definitions
  function handleClick() { }
  function saveData() { }
  async function loadData() { }

  // 3. Event listeners and initialization
  document.addEventListener('DOMContentLoaded', init);

  // 4. Window exports LAST (after all functions defined)
  window.handleClick = handleClick;
  window.saveData = saveData;
  window.loadData = loadData;
</script>
```

### 5. Defensive Export Pattern (Optional)

For critical applications, wrap exports defensively:
```javascript
// Logs warning instead of crashing if function missing
['handleClick', 'saveData', 'loadData'].forEach(name => {
  if (typeof window[name] === 'undefined' && typeof eval(name) === 'function') {
    window[name] = eval(name);
  } else if (typeof eval(name) !== 'function') {
    console.warn(`Export warning: ${name} is not defined`);
  }
});
```

---

## 6. API Response Data Wrapper Mismatch

**Common silent bug:** Backend returns `{ success: true, data: {...} }` but frontend accesses properties directly.

```javascript
// Backend returns:
res.json({ success: true, data: { previous_quantity: 5, new_quantity: 8 } });

// WRONG - Shows "undefined → undefined" in UI
const result = await response.json();
showToast(`Updated: ${result.previous_quantity} → ${result.new_quantity}`);

// CORRECT - Extract data object first
const result = await response.json();
showToast(`Updated: ${result.data.previous_quantity} → ${result.data.new_quantity}`);

// ALSO CORRECT - Use optional chaining with fallback for compatibility
const result = await response.json();
const data = result.data || result;  // Handle both formats
showToast(`Updated: ${data.previous_quantity} → ${data.new_quantity}`);
```

**Debugging:** If UI shows "undefined" where values should be, check:
1. Network tab → Response body structure
2. Compare backend `res.json({...})` with frontend property access
3. Look for `data:` wrapper in response

**Prevention:** When adding new API endpoints, verify frontend accesses match the exact response structure.

**Note:** Response formats are inconsistent across routes. This is tracked in [BACKLOG-3](./TECHNICAL_DEBT.md#backlog-3-response-format-inconsistency).

---

## Event Delegation Before/After Example

```html
<!-- BEFORE (requires unsafe-inline, CSP violation): -->
<button onclick="refreshLogs()">Refresh</button>
<select onchange="filterLogs()">

<!-- AFTER (CSP compliant): -->
<button data-action="refreshLogs">Refresh</button>
<select data-change="filterLogs">
```

Global functions are automatically discovered by the event delegation module at `/public/js/event-delegation.js`.

---

## Migration Status

**Phase 1 COMPLETE**: All inline event handlers (`onclick`, `onchange`, etc.) migrated to event delegation pattern.
- 27 HTML files migrated
- ~335 handlers converted
- No inline `onclick`, `onchange`, etc. handlers remain

**Phase 2 IN PROGRESS**: Externalizing inline `<script>` blocks to `/public/js/`.
- See [P0-4 in TECHNICAL_DEBT.md](./TECHNICAL_DEBT.md#p0-4-csp-allows-unsafe-inline) for progress
