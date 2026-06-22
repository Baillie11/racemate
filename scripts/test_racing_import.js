const path = require('path');

process.env.RACEMATE_DB_PATH = process.env.RACEMATE_DB_PATH || path.join(__dirname, '..', 'tmp', 'racing-import-test.db');

const db = require('../db/database');
const { importToday } = require('../src/services/racingImportService');

async function main() {
    await db.initSchema();
    const result = await importToday({ providerName: process.env.RACING_PROVIDER || 'sample' });
    console.log(JSON.stringify(result, null, 2));
    if (!result.summary || result.summary.meetings === 0 || result.summary.races === 0 || result.summary.runners === 0) {
        throw new Error('Sample racing import did not create meetings, races, and runners');
    }
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
