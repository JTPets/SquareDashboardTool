# Vendor Management Portal - Future Enhancement

## Priority: HIGH
**Status:** Planned
**Created:** 2025-11-14

## Overview
Need to create a vendor management portal to allow easy configuration of vendor-specific settings and product data without directly editing the database.

## Required Features

### 1. Vendor Settings Management
- **Lead Time Configuration**
  - Set default lead time (in days) per vendor
  - Currently defaults to 7 days if not set
  - Critical for accurate Expected Delivery dates in PO CSV exports
  - Affects reorder suggestions and PO generation

### 2. Product/Variation Management
- **Case Pack Quantities**
  - Set case pack quantity per product variation
  - Used in reorder quantity calculations
  - Ensures orders align with vendor case pack requirements

- **Stock Alert Thresholds**
  - `stock_alert_min`: Minimum stock threshold (triggers reorder)
  - `stock_alert_max`: Maximum stock level (prevents over-ordering)
  - Currently managed via database only
  - Need UI to set and adjust these per product

- **Reorder Multiples**
  - Set quantity multiples for ordering (e.g., must order in multiples of 6)
  - Vendor-specific ordering constraints

### 3. Vendor-Product Associations
- **Vendor Codes**
  - Manage vendor-specific SKU/product codes
  - Currently in `variation_vendors.vendor_code`
  - Used in Square PO CSV exports

- **Vendor Pricing**
  - Set and update unit costs per vendor
  - Historical cost tracking
  - Bulk price updates

### 4. Product Data Fields
- **GTIN/UPC Management**
  - Currently stored in `variations.upc`
  - Used as GTIN in Square imports
  - Need easy way to add/update barcodes

- **Preferred Stock Levels**
  - Target inventory levels per product
  - Used in demand forecasting

## Current Workarounds
- Manual database updates via SQL
- Default values hardcoded in application logic
- No validation or bulk editing capabilities

## Technical Notes
- Database tables already exist with these fields
- UI needs to be built on top of existing schema
- Consider admin role/permissions for access control

## Dependencies
- Existing database schema (already supports all fields)
- Admin authentication/authorization system
- Possibly integrate with existing Square catalog sync

## Suggested Implementation Priority
1. **Phase 1**: Vendor lead times and basic settings
2. **Phase 2**: Product stock thresholds and case packs
3. **Phase 3**: Vendor codes and pricing management
4. **Phase 4**: Bulk import/export capabilities

## Related Files
- Database: `/database/schema.sql`
  - Tables: `vendors`, `variations`, `variation_vendors`
- Reorder Logic: `/server.js` (lines 1460-1792)
- CSV Export: `/server.js` (lines 2662-2778)

## Impact
- **High**: Affects PO generation, reorder suggestions, Square imports
- **User Benefit**: Self-service configuration vs. requiring developer
- **Business Value**: Faster onboarding of new vendors, accurate inventory levels

---

**Next Steps:**
1. Design UI mockups for vendor management portal
2. Define user roles and permissions
3. Build API endpoints for vendor/product CRUD operations
4. Create admin dashboard UI
5. Add audit logging for changes
