#!/usr/bin/env node
/**
 * Fetch Square locations using .env credentials
 * Usage: node scripts/get-locations.js
 */

require('dotenv').config();

const accessToken = process.env.SQUARE_ACCESS_TOKEN;
const environment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

if (!accessToken || accessToken.includes('your_')) {
    console.error('Error: SQUARE_ACCESS_TOKEN not configured in .env');
    process.exit(1);
}

const baseUrl = environment === 'production' 
    ? 'https://connect.squareup.com' 
    : 'https://connect.squareupsandbox.com';

async function getLocations() {
    try {
        const response = await fetch(`${baseUrl}/v2/locations`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('API Error:', error);
            process.exit(1);
        }

        const data = await response.json();
        
        console.log('\n=== Your Square Locations ===\n');
        console.log(`Environment: ${environment.toUpperCase()}\n`);
        
        if (!data.locations || data.locations.length === 0) {
            console.log('No locations found.');
            return;
        }

        data.locations.forEach((loc, i) => {
            console.log(`${i + 1}. ${loc.name}`);
            console.log(`   ID: ${loc.id}`);
            console.log(`   Status: ${loc.status}`);
            if (loc.address) {
                const addr = loc.address;
                console.log(`   Address: ${addr.address_line_1 || ''} ${addr.locality || ''}, ${addr.administrative_district_level_1 || ''}`);
            }
            console.log('');
        });

        console.log('---');
        console.log('Add to .env:');
        console.log(`SQUARE_LOCATION_ID=${data.locations[0].id}`);
        
    } catch (error) {
        console.error('Error fetching locations:', error.message);
        process.exit(1);
    }
}

getLocations();
