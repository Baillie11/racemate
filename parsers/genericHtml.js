/**
 * Generic HTML Parser
 * Attempts to extract race/runner data from publicly accessible HTML pages
 * 
 * NOTE: This parser only works with publicly accessible pages.
 * It will NOT bypass logins, paywalls, or bot protections.
 */

const https = require('https');
const http = require('http');

/**
 * Fetch a URL with basic error handling
 */
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const req = protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; HorseRacingApp/1.0)',
                'Accept': 'text/html'
            },
            timeout: 10000
        }, (res) => {
            // Check for redirects to login pages
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers.location;
                if (location && (location.includes('login') || location.includes('signin'))) {
                    reject(new Error('Page requires login - cannot access'));
                    return;
                }
            }
            
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}: Unable to fetch page`));
                return;
            }
            
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
    });
}

/**
 * Check if page appears to be behind a paywall or login
 */
function isProtectedContent(html) {
    const protectedIndicators = [
        'login', 'sign in', 'signin', 'log in',
        'subscribe', 'subscription required',
        'premium content', 'members only',
        'please register', 'create account'
    ];
    
    const lowerHtml = html.toLowerCase();
    return protectedIndicators.some(indicator => lowerHtml.includes(indicator));
}

/**
 * Extract basic table data from HTML
 * This is a very basic parser - most sites will need custom adapters
 */
function extractTableData(html) {
    const results = [];
    
    // Find all tables
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tableMatch;
    
    while ((tableMatch = tableRegex.exec(html)) !== null) {
        const tableHtml = tableMatch[1];
        const rows = [];
        
        // Extract rows
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        
        while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
            const cells = [];
            const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
            let cellMatch;
            
            while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
                // Clean HTML tags
                const text = cellMatch[1]
                    .replace(/<[^>]*>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                cells.push(text);
            }
            
            if (cells.length > 0) {
                rows.push(cells);
            }
        }
        
        if (rows.length > 1) {
            results.push(rows);
        }
    }
    
    return results;
}

/**
 * Try to identify if a table contains runner data
 */
function identifyRunnerTable(rows) {
    if (rows.length < 2) return null;
    
    const header = rows[0].map(h => h.toLowerCase());
    
    // Look for common runner table columns
    const runnerIndicators = ['horse', 'runner', 'name', 'barrier', 'jockey', 'weight', 'odds'];
    const matches = header.filter(h => runnerIndicators.some(ind => h.includes(ind)));
    
    if (matches.length >= 2) {
        return {
            headers: header,
            data: rows.slice(1)
        };
    }
    
    return null;
}

/**
 * Main parse function
 * Returns structured data or throws error
 */
async function parseUrl(url) {
    try {
        console.log(`Attempting to parse: ${url}`);
        
        const html = await fetchUrl(url);
        
        // Check for protected content
        if (isProtectedContent(html)) {
            throw new Error(
                'This page appears to require login or subscription. ' +
                'Please use manual CSV/JSON import instead.'
            );
        }
        
        const tables = extractTableData(html);
        
        if (tables.length === 0) {
            throw new Error(
                'No data tables found on page. ' +
                'This parser may not support this website format. ' +
                'Please use manual CSV/JSON import instead.'
            );
        }
        
        // Try to find runner tables
        const runnerTables = [];
        for (const table of tables) {
            const identified = identifyRunnerTable(table);
            if (identified) {
                runnerTables.push(identified);
            }
        }
        
        if (runnerTables.length === 0) {
            return {
                success: false,
                error: 'Could not identify runner data in page tables.',
                suggestion: 'Please use manual CSV/JSON import instead.',
                rawTables: tables.length
            };
        }
        
        return {
            success: true,
            tables: runnerTables,
            message: `Found ${runnerTables.length} potential runner table(s)`,
            warning: 'Data may need manual verification'
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message,
            suggestion: 'Please use manual CSV/JSON import for reliable data entry.'
        };
    }
}

/**
 * Parse a simple racing results page (very basic)
 */
async function parseResults(url) {
    try {
        const html = await fetchUrl(url);
        
        // Look for position/result indicators
        const results = [];
        const positionRegex = /(?:1st|2nd|3rd|first|second|third|winner)[:\s]+([^<\n]+)/gi;
        let match;
        
        while ((match = positionRegex.exec(html)) !== null) {
            results.push(match[1].trim());
        }
        
        return {
            success: results.length > 0,
            results,
            message: results.length > 0 ? 
                `Found ${results.length} result indicators` : 
                'No results found'
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    parseUrl,
    parseResults,
    fetchUrl,
    extractTableData
};
