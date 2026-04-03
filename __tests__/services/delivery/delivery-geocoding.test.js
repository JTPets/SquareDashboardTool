/**
 * Tests for new helpers in services/delivery/delivery-geocoding.js:
 *   geocodeAndPatchOrder — get settings, geocode, update order
 *   updateSettingsWithGeocode — geocode start/end, persist settings
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockGetSettings = jest.fn();
const mockUpdateSettings = jest.fn();
jest.mock('../../../services/delivery/delivery-settings', () => ({
    getSettings: mockGetSettings,
    updateSettings: mockUpdateSettings
}));

const mockUpdateOrder = jest.fn();
jest.mock('../../../services/delivery/delivery-orders', () => ({
    updateOrder: mockUpdateOrder
}));

// Mock global fetch for geocodeAddress
const mockFetch = jest.fn();
global.fetch = mockFetch;

jest.mock('../../../services/delivery/delivery-utils', () => ({
    ORS_BASE_URL: 'https://api.openrouteservice.org/v2',
    ORS_API_KEY: null
}));

const { geocodeAndPatchOrder, updateSettingsWithGeocode } = require('../../../services/delivery/delivery-geocoding');

const MERCHANT_ID = 1;
const ORDER_ID = 'order-uuid-1234';

function mockGeoSuccess(lat = 43.6, lng = -79.3) {
    mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
            features: [{ geometry: { coordinates: [lng, lat] }, properties: { confidence: 0.9 } }]
        })
    });
}

function mockGeoFail() {
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ features: [] }) });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSettings.mockResolvedValue({ openrouteservice_api_key: 'test-key' });
    mockUpdateOrder.mockResolvedValue({});
    mockUpdateSettings.mockResolvedValue({ merchant_id: MERCHANT_ID });
});

// ─── geocodeAndPatchOrder ────────────────────────────────────────────────────

describe('geocodeAndPatchOrder', () => {
    it('geocodes address and updates order coords', async () => {
        mockGeoSuccess(43.65, -79.38);
        const coords = await geocodeAndPatchOrder(MERCHANT_ID, ORDER_ID, '100 King St W, Toronto');
        expect(coords).toMatchObject({ lat: 43.65, lng: -79.38 });
        expect(mockUpdateOrder).toHaveBeenCalledWith(
            MERCHANT_ID, ORDER_ID,
            expect.objectContaining({ addressLat: 43.65, addressLng: -79.38 })
        );
    });

    it('returns null and skips update when geocoding returns no results', async () => {
        mockGeoFail();
        const coords = await geocodeAndPatchOrder(MERCHANT_ID, ORDER_ID, 'Nowhere Lane');
        expect(coords).toBeNull();
        expect(mockUpdateOrder).not.toHaveBeenCalled();
    });

    it('returns null when no API key is available', async () => {
        mockGetSettings.mockResolvedValue({ openrouteservice_api_key: null });
        const coords = await geocodeAndPatchOrder(MERCHANT_ID, ORDER_ID, '123 Main St');
        expect(coords).toBeNull();
        expect(mockUpdateOrder).not.toHaveBeenCalled();
    });
});

// ─── updateSettingsWithGeocode ───────────────────────────────────────────────

describe('updateSettingsWithGeocode', () => {
    it('geocodes start and end addresses before saving', async () => {
        mockGeoSuccess(43.65, -79.38);
        await updateSettingsWithGeocode(MERCHANT_ID, {
            startAddress: '100 King St W',
            endAddress: '200 Queen St E',
            sameDayCutoff: '17:00'
        });
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockUpdateSettings).toHaveBeenCalledWith(
            MERCHANT_ID,
            expect.objectContaining({
                startAddressLat: expect.any(Number),
                endAddressLat: expect.any(Number)
            })
        );
    });

    it('saves settings without geocoding when no addresses provided', async () => {
        await updateSettingsWithGeocode(MERCHANT_ID, { sameDayCutoff: '12:00' });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockUpdateSettings).toHaveBeenCalledWith(
            MERCHANT_ID,
            expect.objectContaining({ startAddressLat: null, endAddressLat: null })
        );
    });

    it('saves null coords when geocoding fails for an address', async () => {
        mockGeoFail();
        await updateSettingsWithGeocode(MERCHANT_ID, { startAddress: 'Unknown Place' });
        expect(mockUpdateSettings).toHaveBeenCalledWith(
            MERCHANT_ID,
            expect.objectContaining({ startAddressLat: null, startAddressLng: null })
        );
    });

    it('uses openrouteserviceApiKey from body when no stored key', async () => {
        mockGetSettings.mockResolvedValue({ openrouteservice_api_key: null });
        mockGeoSuccess();
        await updateSettingsWithGeocode(MERCHANT_ID, {
            startAddress: '1 Yonge St',
            openrouteserviceApiKey: 'body-key'
        });
        // fetch should have been called (key came from body)
        expect(mockFetch).toHaveBeenCalled();
    });

    it('returns the result of updateSettings', async () => {
        const expected = { merchant_id: MERCHANT_ID, same_day_cutoff: '09:00' };
        mockUpdateSettings.mockResolvedValue(expected);
        const result = await updateSettingsWithGeocode(MERCHANT_ID, { sameDayCutoff: '09:00' });
        expect(result).toBe(expected);
    });
});
