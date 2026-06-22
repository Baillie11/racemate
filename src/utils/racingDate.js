function getRacingTimezone() {
    return process.env.TIMEZONE || 'Australia/Brisbane';
}

function todayISO(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: getRacingTimezone(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

module.exports = { getRacingTimezone, todayISO };
