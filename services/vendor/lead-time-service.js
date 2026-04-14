/**
 * Vendor Lead Time Service
 *
 * Computes the effective lead time (in days) for a vendor. For "fixed" schedule
 * vendors, the effective lead time is derived from the configured order_day and
 * receive_day (e.g., order Thursday → receive Monday = 4 days). When order_day
 * or receive_day equal the same weekday, the vendor receives the following week
 * (7 days). For "anytime" vendors — or when required day fields are missing —
 * the stored `lead_time_days` value is used verbatim.
 *
 * Runtime-only calculation: the stored `lead_time_days` column is never
 * mutated by this helper.
 */

const DAY_INDEX = {
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sunday: 7
};

/**
 * Compute effective lead time for a vendor.
 *
 * @param {object} vendor - Vendor row. Expected fields:
 *   - schedule_type: 'fixed' | 'anytime' | null
 *   - order_day: weekday name (lowercase preferred) | null
 *   - receive_day: weekday name | null
 *   - lead_time_days: stored fallback value | null
 * @returns {number|null} lead time in days (1-7 for fixed, stored value otherwise)
 */
function calculateLeadTime(vendor) {
    if (!vendor) return null;
    if (vendor.schedule_type !== 'fixed') return vendor.lead_time_days;
    if (!vendor.order_day || !vendor.receive_day) return vendor.lead_time_days;

    const order = DAY_INDEX[String(vendor.order_day).toLowerCase()];
    const receive = DAY_INDEX[String(vendor.receive_day).toLowerCase()];
    if (!order || !receive) return vendor.lead_time_days;

    const diff = (receive - order + 7) % 7;
    return diff === 0 ? 7 : diff;
}

/**
 * SQL expression computing the effective lead time days for a vendor row.
 * Mirrors calculateLeadTime() in SQL. The caller supplies the table alias
 * containing `schedule_type`, `order_day`, `receive_day`, and `lead_time_days`.
 *
 * For fixed-schedule vendors with both days set, computes
 *   ((receive - order + 7) % 7), with same-day returning 7.
 * Otherwise returns COALESCE(<alias>.lead_time_days, 0).
 *
 * @param {string} alias - table alias (e.g. 've')
 * @returns {string} SQL fragment (unparenthesized)
 */
function leadTimeSqlExpr(alias = 've') {
    const a = alias;
    const dayCase = (col) =>
        `CASE LOWER(${a}.${col}) ` +
        `WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 ` +
        `WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 ` +
        `WHEN 'sunday' THEN 7 ELSE NULL END`;
    const diff = `((${dayCase('receive_day')} - ${dayCase('order_day')} + 7) % 7)`;
    return `CASE
        WHEN ${a}.schedule_type = 'fixed'
             AND ${a}.order_day IS NOT NULL
             AND ${a}.receive_day IS NOT NULL
             AND ${dayCase('order_day')} IS NOT NULL
             AND ${dayCase('receive_day')} IS NOT NULL
        THEN CASE WHEN ${diff} = 0 THEN 7 ELSE ${diff} END
        ELSE COALESCE(${a}.lead_time_days, 0)
    END`;
}

module.exports = { calculateLeadTime, leadTimeSqlExpr, DAY_INDEX };
