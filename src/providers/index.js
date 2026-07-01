const { assertProvider } = require('./racingProvider');
const SampleRacingProvider = require('./sampleProvider');
const TabProvider = require('./tabProvider');
const RacenetProvider = require('./racenetProvider');

function createRacingProvider(name = process.env.RACING_PROVIDER || 'sample', options = {}) {
    switch (String(name).toLowerCase()) {
        case 'sample':
            return assertProvider(new SampleRacingProvider());
        case 'tab':
            return assertProvider(new TabProvider());
        case 'racenet':
            return assertProvider(new RacenetProvider(options));
        default:
            throw new Error(`Unknown racing provider: ${name}`);
    }
}

module.exports = { createRacingProvider };
