/**
 * Track List Generator
 * Fetches Australian racing track information from Racing Australia
 * and generates public/data/au_tracks.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TRACK_URL = 'https://racingaustralia.horse/FAQ/Track-Information.aspx';
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'data', 'au_tracks.json');
const ALIASES_PATH = path.join(__dirname, '..', 'public', 'data', 'track_aliases.json');

// Supported states
const SUPPORTED_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

function createEmptyTrackMap() {
    return SUPPORTED_STATES.reduce((acc, state) => {
        acc[state] = [];
        return acc;
    }, {});
}

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function parseTracksFromHtml(html) {
    const tracks = createEmptyTrackMap();
    
    // Extract table rows - looking for pattern: Track Name | Code | Area
    // The HTML structure has rows with track info
    const tableRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    
    const rows = html.match(tableRegex) || [];
    
    for (const row of rows) {
        const cells = [];
        let match;
        const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        
        while ((match = cellPattern.exec(row)) !== null) {
            // Clean HTML tags and whitespace
            const text = match[1].replace(/<[^>]*>/g, '').trim();
            cells.push(text);
        }
        
        // We expect: Track Name, Code, Area (state)
        if (cells.length >= 3) {
            const trackName = cells[0];
            const state = cells[2].toUpperCase();
            
            if (SUPPORTED_STATES.includes(state) && trackName && trackName.length > 1) {
                if (!tracks[state].includes(trackName)) {
                    tracks[state].push(trackName);
                }
            }
        }
    }
    
    // Sort each state's tracks alphabetically
    for (const state of SUPPORTED_STATES) {
        tracks[state].sort((a, b) => a.localeCompare(b));
    }
    
    return tracks;
}

function generateAliases(tracks) {
    // Generate common aliases for tracks
    const aliases = {};
    
    // Identity mappings (each track maps to itself)
    for (const state of Object.keys(tracks)) {
        for (const track of tracks[state]) {
            aliases[track] = track;
        }
    }
    
    // Add common known aliases
    const knownAliases = {
        'Randwick': 'Royal Randwick',
        'Flemington': 'Flemington',
        'Moonee Valley': 'The Valley',
        'Caulfield': 'Caulfield',
        'Rosehill': 'Rosehill Gardens',
        'Eagle Farm': 'Eagle Farm',
        'Doomben': 'Doomben'
    };
    
    for (const [alias, canonical] of Object.entries(knownAliases)) {
        // Only add if the canonical name exists in our tracks
        for (const state of Object.keys(tracks)) {
            if (tracks[state].includes(canonical) || tracks[state].includes(alias)) {
                aliases[alias] = canonical;
            }
        }
    }
    
    return aliases;
}

async function updateTracks() {
    console.log('Fetching track list from Racing Australia...');
    
    try {
        const html = await fetchPage(TRACK_URL);
        console.log(`Fetched ${html.length} bytes`);
        
        const tracks = parseTracksFromHtml(html);
        
        // Validate we got some tracks
        const totalTracks = Object.values(tracks).reduce((sum, arr) => sum + arr.length, 0);
        
        if (totalTracks === 0) {
            console.log('Warning: No tracks parsed from HTML. Using fallback list.');
            // Use a fallback list of major tracks
            tracks.NSW = [
                'Bathurst', 'Canterbury Park', 'Cessnock', 'Coffs Harbour', 'Dubbo',
                'Gosford', 'Hawkesbury', 'Kembla Grange', 'Kensington', 'Moruya',
                'Muswellbrook', 'Newcastle', 'Nowra', 'Port Macquarie', 'Queanbeyan',
                'Randwick', 'Rosehill Gardens', 'Scone', 'Tamworth', 'Wagga Wagga', 
                'Warwick Farm', 'Wyong'
            ];
            tracks.VIC = [
                'Bairnsdale', 'Ballarat', 'Benalla', 'Bendigo', 'Caulfield',
                'Cranbourne', 'Echuca', 'Flemington', 'Geelong', 'Hamilton',
                'Kilmore', 'Moe', 'Moonee Valley', 'Mornington', 'Pakenham',
                'Sale', 'Sandown Hillside', 'Sandown Lakeside', 'Seymour',
                'Stony Creek', 'Swan Hill', 'The Valley', 'Wangaratta', 'Warrnambool', 'Yarra Valley'
            ];
            tracks.QLD = [
                'Beaudesert', 'Brisbane', 'Bundaberg', 'Cairns', 'Caloundra',
                'Dalby', 'Doomben', 'Eagle Farm', 'Gold Coast', 'Ipswich',
                'Mackay', 'Rockhampton', 'Sunshine Coast', 'Toowoomba', 'Townsville'
            ];
            tracks.SA = [
                'Balaklava', 'Gawler', 'Morphettville', 'Port Lincoln', 'Strathalbyn'
            ];
            tracks.TAS = [
                'Devonport', 'Hobart', 'Launceston'
            ];
            tracks.WA = [
                'Ascot', 'Belmont', 'Bunbury', 'Kalgoorlie', 'Pinjarra'
            ];
            tracks.NT = [
                'Alice Springs', 'Darwin'
            ];
            tracks.ACT = [
                'Canberra'
            ];
        }
        
        // Ensure output directory exists
        const outputDir = path.dirname(OUTPUT_PATH);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        // Write tracks file
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(tracks, null, 2));
        console.log(`Saved ${totalTracks || 'fallback'} tracks to ${OUTPUT_PATH}`);
        
        // Generate and write aliases
        const aliases = generateAliases(tracks);
        fs.writeFileSync(ALIASES_PATH, JSON.stringify(aliases, null, 2));
        console.log(`Saved aliases to ${ALIASES_PATH}`);
        
        // Print summary
        console.log('\nTrack Summary:');
        for (const state of SUPPORTED_STATES) {
            console.log(`  ${state}: ${tracks[state].length} tracks`);
        }
        
        return tracks;
        
    } catch (error) {
        console.error('Error updating tracks:', error.message);
        
        // If the file doesn't exist at all, create a minimal fallback
        if (!fs.existsSync(OUTPUT_PATH)) {
            console.log('Creating fallback track list...');
            const fallback = createEmptyTrackMap();
            fallback.NSW = ['Randwick', 'Rosehill Gardens', 'Canterbury Park', 'Warwick Farm'];
            fallback.VIC = ['Flemington', 'Caulfield', 'The Valley', 'Sandown'];
            fallback.QLD = ['Eagle Farm', 'Doomben', 'Gold Coast', 'Sunshine Coast'];
            fallback.SA = ['Morphettville', 'Gawler'];
            fallback.TAS = ['Hobart', 'Launceston'];
            fallback.WA = ['Ascot', 'Belmont'];
            fallback.NT = ['Darwin'];
            fallback.ACT = ['Canberra'];
            
            const outputDir = path.dirname(OUTPUT_PATH);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            
            fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fallback, null, 2));
            fs.writeFileSync(ALIASES_PATH, JSON.stringify({}, null, 2));
            console.log('Fallback track list created.');
        }
        
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    updateTracks();
}

module.exports = { updateTracks, TRACK_URL, OUTPUT_PATH };
