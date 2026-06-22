-- Settings table (key/value store)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Meetings table
CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    state TEXT NOT NULL,
    track TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    source_meeting_id TEXT,
    country TEXT DEFAULT 'AUS',
    race_type TEXT DEFAULT 'horse',
    weather TEXT,
    rail_position TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, state, track)
);

-- Races table
CREATE TABLE IF NOT EXISTS races (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    race_no INTEGER NOT NULL,
    source TEXT DEFAULT 'manual',
    source_race_id TEXT,
    race_name TEXT,
    start_time TEXT,
    distance INTEGER,
    track_condition TEXT,
    race_class TEXT,
    prize_money INTEGER,
    status TEXT DEFAULT 'scheduled',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    UNIQUE(meeting_id, race_no)
);

-- Runners table
CREATE TABLE IF NOT EXISTS runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL,
    saddle_no INTEGER NOT NULL,
    source TEXT DEFAULT 'manual',
    source_runner_id TEXT,
    horse_name TEXT NOT NULL,
    barrier INTEGER,
    weight REAL,
    jockey TEXT,
    trainer TEXT,
    form_string TEXT,
    last_starts TEXT,
    career_wins INTEGER DEFAULT 0,
    career_places INTEGER DEFAULT 0,
    career_starts INTEGER DEFAULT 0,
    track_wins INTEGER DEFAULT 0,
    track_starts INTEGER DEFAULT 0,
    distance_wins INTEGER DEFAULT 0,
    distance_starts INTEGER DEFAULT 0,
    rating REAL,
    speed_rating REAL,
    dry_track_rating REAL,
    wet_track_rating REAL,
    class_rating REAL,
    days_since_last_run INTEGER,
    weight_change REAL,
    gear_changes TEXT,
    comments TEXT,
    scratched INTEGER DEFAULT 0,
    odds_win REAL,
    odds_place REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE,
    UNIQUE(race_id, saddle_no)
);

-- Provider odds snapshots for later analysis/backtesting
CREATE TABLE IF NOT EXISTS odds_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runner_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    win_odds REAL,
    place_odds REAL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
);

-- Provider result rows, separate from manual race_results placings
CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL,
    runner_id INTEGER,
    finishing_position INTEGER,
    margin TEXT,
    starting_price REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE,
    FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE SET NULL,
    UNIQUE(race_id, runner_id)
);

-- Provider or internal tips, kept separate from selections/bets
CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL,
    runner_id INTEGER,
    tip_type TEXT,
    confidence REAL,
    reasoning TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE,
    FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE SET NULL,
    UNIQUE(race_id, runner_id, tip_type)
);

-- Selections table (model predictions)
CREATE TABLE IF NOT EXISTS selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL,
    runner_id INTEGER NOT NULL,
    model_version TEXT DEFAULT 'v1',
    score REAL,
    prob_win_est REAL,
    prob_place_est REAL,
    odds_win REAL,
    odds_place REAL,
    ev_win REAL,
    ev_place REAL,
    recommendation_status TEXT CHECK(recommendation_status IN ('bet', 'skip', 'no_data')),
    explanation_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE,
    FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
);

-- Bets table
CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    selection_id INTEGER NOT NULL,
    stake_win REAL DEFAULT 0,
    stake_place REAL DEFAULT 0,
    odds_win REAL,
    odds_place REAL,
    placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'won', 'placed', 'lost', 'void')),
    result_position INTEGER,
    payout_win REAL DEFAULT 0,
    payout_place REAL DEFAULT 0,
    settled_at DATETIME,
    FOREIGN KEY (selection_id) REFERENCES selections(id) ON DELETE CASCADE
);

-- Race results table (entered placings by race)
CREATE TABLE IF NOT EXISTS race_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL UNIQUE,
    first_saddle INTEGER,
    second_saddle INTEGER,
    third_saddle INTEGER,
    settled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

-- Audit log table (append-only activity history)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Transactions ledger
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'bet_stake', 'payout', 'adjustment')),
    amount REAL NOT NULL,
    bet_id INTEGER,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bet_id) REFERENCES bets(id) ON DELETE SET NULL
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
CREATE INDEX IF NOT EXISTS idx_meetings_state_track ON meetings(state, track);
CREATE INDEX IF NOT EXISTS idx_meetings_source ON meetings(source, source_meeting_id);
CREATE INDEX IF NOT EXISTS idx_races_meeting ON races(meeting_id);
CREATE INDEX IF NOT EXISTS idx_races_source ON races(source, source_race_id);
CREATE INDEX IF NOT EXISTS idx_runners_race ON runners(race_id);
CREATE INDEX IF NOT EXISTS idx_runners_source ON runners(source, source_runner_id);
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_runner ON odds_snapshots(runner_id);
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_recorded ON odds_snapshots(recorded_at);
CREATE INDEX IF NOT EXISTS idx_results_race ON results(race_id);
CREATE INDEX IF NOT EXISTS idx_tips_race ON tips(race_id);
CREATE INDEX IF NOT EXISTS idx_selections_race ON selections(race_id);
CREATE INDEX IF NOT EXISTS idx_bets_selection ON bets(selection_id);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE INDEX IF NOT EXISTS idx_race_results_race ON race_results(race_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(created_at);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('target_roi', '1.20'),
    ('min_confidence', '0.15'),
    ('data_completeness_threshold', '0.6'),
    ('staking_mode', 'flat'),
    ('stake_percent', '0.02'),
    ('kelly_fraction', '0.25'),
    ('max_stake_per_race', '100'),
    ('max_daily_loss', '200'),
    ('min_bankroll_floor', '5'),
    ('last_state', 'VIC'),
    ('last_track', ''),
    ('initial_bankroll_set', '0'),
    ('racing_provider', 'sample'),
    ('enable_racing_cron', 'false'),
    ('racing_import_time', '02:00'),
    ('timezone', 'Australia/Brisbane'),
    ('last_racing_import_at', '');
