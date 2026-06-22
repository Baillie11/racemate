const { importToday } = require('../services/racingImportService');
const { todayISO } = require('../utils/racingDate');

const MINUTE_MS = 60 * 1000;

function parseTime(value = '02:00') {
    const [hour, minute] = String(value).split(':').map(part => parseInt(part, 10));
    return {
        hour: Number.isInteger(hour) ? hour : 2,
        minute: Number.isInteger(minute) ? minute : 0
    };
}

function shouldRunNow(lastRunDate, importTime) {
    const now = new Date();
    const today = todayISO(now);
    if (lastRunDate === today) return false;

    const { hour, minute } = parseTime(importTime);
    return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

function startRacingImportCron(options = {}) {
    const enabled = String(options.enabled ?? process.env.ENABLE_RACING_CRON ?? 'false').toLowerCase() === 'true';
    if (!enabled) {
        console.log('Racing import cron disabled');
        return null;
    }

    const importTime = options.importTime || process.env.RACING_IMPORT_TIME || '02:00';
    let lastRunDate = null;

    const timer = setInterval(async () => {
        if (!shouldRunNow(lastRunDate, importTime)) return;

        lastRunDate = todayISO();
        try {
            console.log(`Running scheduled racing import for ${lastRunDate}`);
            await importToday();
        } catch (err) {
            console.error('Scheduled racing import failed:', err.message);
        }
    }, MINUTE_MS);

    console.log(`Racing import cron enabled for ${importTime}`);
    return timer;
}

module.exports = { startRacingImportCron };
