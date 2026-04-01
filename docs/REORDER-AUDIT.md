# Reorder Suggestions System Audit

## Surface Area

File: services/catalog/reorder-service.js
Lines: 819
Exports: getReorderSuggestions, buildMainQuery, processSuggestionRows, sortSuggestions, runBundleAnalysis, fetchOtherVendorItems

File: services/catalog/reorder-math.js
Lines: 108
Exports: calculateReorderQuantity, calculateDaysOfStock

File: routes/analytics.js (reorder-related routes only)
Routes:
- GET /api/reorder-suggestions — Calculate reorder suggestions based on sales velocity

File: public/reorder.html
Lines: 918

File: public/js/reorder.js
Lines: 2348
