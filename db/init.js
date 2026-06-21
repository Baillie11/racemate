const { initSchema } = require('./database');

async function init() {
    console.log('Initializing database...');
    await initSchema();
    console.log('Database initialized successfully!');
}

init().catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
