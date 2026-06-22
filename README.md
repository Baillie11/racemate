# Horse Racing Selection & Bankroll Tracker

A mobile-first web application for Australian horse racing selections (Win + Place only) with comprehensive bankroll tracking.

## ⚠️ Disclaimer

**Gambling involves risk. This app provides estimates, not guarantees. Past performance does not guarantee future results. Please gamble responsibly.**

## Features

- **Track Selection**: Support for VIC, NSW, QLD tracks with auto-loaded track list
- **Selection Engine**: EV-based horse selection with explainable recommendations
- **Win + Place Only**: Exactly one horse per race for Win and Place bets
- **Bankroll Management**: Full transaction ledger with deposits, withdrawals, stakes, and payouts
- **Risk Controls**: Max stake, daily loss limits, bankroll floor protection
- **Analytics Dashboard**: ROI, strike rates, drawdown, bankroll charts
- **Mobile-First Design**: Clean, responsive UI optimized for phones
- **Local Persistence**: SQLite database for offline-capable storage

## Installation

### Prerequisites

- Node.js 18+ (with npm)
- For Windows: You may need build tools for better-sqlite3:
  ```
  npm install --global windows-build-tools
  ```

### Setup

```bash
# Clone/navigate to project directory
cd HorseRacingApp

# Install dependencies
npm install

# Initialize database
npm run init:db

# Update track list (optional - auto-runs on first startup)
npm run update:tracks

# Start the server
npm run dev
```

The app will be available at `http://localhost:3000`

## Usage

### 1. Set Up Bankroll

1. Navigate to the **Bankroll** tab
2. Enter your starting bankroll amount
3. Click "Set Bankroll"

### 2. Import Form Guide Data

The app requires race/runner data to make selections. You can import data via:

#### CSV Import (Recommended)

1. Go to **Settings** tab
2. Click "CSV Upload"
3. Upload a CSV file with form guide data
4. Download the sample CSV template for the expected format

**CSV Format:**
```csv
date,state,track,race_no,race_name,start_time,distance,track_condition,race_class,prize_money,saddle_no,horse_name,barrier,weight,jockey,trainer,form_string,career_wins,career_places,career_starts,track_wins,track_starts,distance_wins,distance_starts,rating,days_since_last_run,odds_win,odds_place
2024-03-15,VIC,Flemington,1,Maiden Plate,12:30,1200,Good,Maiden,50000,1,Swift Runner,3,56.5,J Smith,T Williams,23142,2,4,10,1,3,1,5,72,14,4.50,1.80
```

#### JSON Import

POST to `/api/import/json` with an array of records in the same format.

### 3. Select Meeting & Analyze Races

1. On the **Today** tab, select State, Track, and Date
2. Click "Load Meeting"
3. Click on a race to view the field and recommendation

### 4. Place Bets

When the selection engine recommends a bet:
1. Click "Place Bet"
2. Confirm or adjust the odds and stakes
3. Click "Confirm Bet"

### 5. Settle Results

1. Go to **Results** tab
2. For pending bets, click "Won", "Place", or "Lost"
3. The bankroll automatically updates

## Configuration

### Selection Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Target ROI | 1.20 | Required expected ROI (1.20 = 20% profit) |
| Min Confidence | 0.15 | Minimum win probability to consider |
| Data Threshold | 0.6 | Minimum data completeness (0-1) |

### Staking Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Mode | Flat | "flat" or "kelly" |
| Stake % | 0.02 | 2% of bankroll per race (flat mode) |
| Kelly Fraction | 0.25 | Quarter-Kelly (conservative) |

### Risk Controls

| Setting | Default | Description |
|---------|---------|-------------|
| Max Stake | $100 | Maximum stake per race |
| Max Daily Loss | $200 | Stop betting after this loss |
| Bankroll Floor | $5 | Never bet below this amount |

## Selection Engine (v1)

The selection engine scores horses based on:

- **Form (25%)**: Recent finishing positions
- **Barrier (15%)**: Position relative to field and distance
- **Weight (10%)**: Weight carried vs field
- **Career Win Rate (15%)**: Wins/starts
- **Track Record (10%)**: Performance at this track
- **Distance Record (10%)**: Performance at this distance
- **Recency (10%)**: Days since last run
- **Rating (5%)**: Official rating if available

Scores are converted to probability estimates, and Expected Value is calculated:
```
EV = p × (odds - 1) - (1 - p)
```

A bet is only recommended if:
1. EV meets target ROI threshold
2. Win probability meets confidence threshold
3. Sufficient data is available

## API Endpoints

### Tracks
- `GET /api/tracks` - Get track list by state
- `POST /api/tracks/update` - Refresh track list

### Settings
- `GET /api/settings` - Get all settings
- `POST /api/settings` - Update settings

### Meetings & Races
- `GET /api/meeting?state=VIC&track=Flemington&date=2024-01-01` - Get meeting
- `GET /api/races/:id` - Get race with runners
- `POST /api/races/:id/analyze` - Run selection engine

### Bets
- `GET /api/bets` - Get all bets
- `POST /api/bets` - Place bet
- `POST /api/results/:betId` - Settle bet

### Bankroll
- `GET /api/bankroll` - Get current bankroll
- `GET /api/bankroll/summary` - Get full summary
- `POST /api/bankroll/initial` - Set initial bankroll
- `POST /api/bankroll/deposit` - Deposit funds
- `POST /api/bankroll/withdraw` - Withdraw funds

### Import/Export
- `POST /api/import/csv` - Import CSV (multipart/form-data)
- `POST /api/import/json` - Import JSON
- `GET /api/export/bets` - Export bets CSV
- `GET /api/export/transactions` - Export transactions CSV

### Backup
- `GET /api/backup/db` - Download SQLite database
- `GET /api/backup/json` - Export all data as JSON

## Project Structure

```
HorseRacingApp/
├── server.js              # Express server & API routes
├── package.json
├── README.md
├── db/
│   ├── database.js        # SQLite wrapper & operations
│   ├── schema.sql         # Database schema
│   └── init.js            # DB initialization script
├── services/
│   ├── selector.js        # Selection engine
│   ├── staking.js         # Stake calculations
│   └── bankroll.js        # Bankroll management
├── parsers/
│   ├── genericHtml.js     # HTML parser (best-effort)
│   └── skeletonSportsbookAdapter.js
├── scripts/
│   └── update_tracks.js   # Track list generator
├── sample-data/
│   └── sample_form.csv    # Sample import template
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── data/
│       └── au_tracks.json
└── data/
    └── racing.db          # SQLite database (created on startup)
```

## npm Scripts

```bash
npm run dev          # Start development server
npm run start        # Start server
npm run init:db      # Initialize database
npm run update:tracks # Update track list from Racing Australia
npm run import:sample # Smoke-test the automated racing importer with sample data
npm run test:import  # Same import smoke test, using a temporary SQLite DB
```

## Automated Racing Import

RaceMate includes a modular racing data import workflow for Australian horse racing meetings. It is designed so the app calls a generic provider interface instead of depending directly on one racing website.

The provider interface lives in `src/providers/racingProvider.js` and exposes:

```js
getTodaysMeetings()
getRacesForMeeting(meeting)
getRunnersForRace(race)
getResultsForRace(race)
getOddsForRace(race)
```

Current providers:

- `sample` - working sample provider for local testing and UI development.
- `tab` - placeholder only. Add a compliant feed/API integration before enabling.
- `racenet` - placeholder only. Add a compliant feed/API integration before enabling.

Do not use this workflow to bypass logins, paywalls, captchas, robots.txt, or access protections. Real providers should use approved APIs, licensed feeds, exported files, or other compliant data sources.

### Environment Variables

```bash
RACING_PROVIDER=sample
ENABLE_RACING_CRON=false
RACING_IMPORT_TIME=02:00
TIMEZONE=Australia/Brisbane
```

`ENABLE_RACING_CRON=false` is the recommended setting on cPanel shared hosting unless you are sure the Node process stays alive and you want the app itself to run the daily import. You can keep cron disabled and use the dashboard button or API endpoint instead.

### Run Import Locally

```bash
npm run test:import
```

The test script uses a temporary database at `tmp/racing-import-test.db`, so it does not touch your normal `data/racing.db` file.

### Trigger Import Manually

From the dashboard, use the **Import Today's Meetings** button in the Automated Racing Import section.

You can also call the API:

```bash
curl -X POST http://localhost:3000/racemate/api/racing/import/today ^
  -H "Content-Type: application/json" ^
  -d "{\"provider\":\"sample\"}"
```

If running locally without `BASE_PATH=/racemate`, use:

```bash
curl -X POST http://localhost:3000/api/racing/import/today ^
  -H "Content-Type: application/json" ^
  -d "{\"provider\":\"sample\"}"
```

### Racing Import API

- `GET /api/racing/meetings/today` - today's imported meetings.
- `GET /api/racing/meetings/:id/races` - races for one imported meeting.
- `GET /api/racing/races/:id/runners` - runners for one imported race.
- `POST /api/racing/import/today` - run today's configured provider import.
- `POST /api/racing/import/results` - stub for later results import.
- `POST /api/racing/import/odds` - stub for later odds snapshots.

The importer uses upsert logic for meetings, races, and runners, so it can be safely run more than once without duplicating provider-sourced records.

### Known Limitations

- The only working provider is `sample`.
- TAB and Racenet provider files are intentional stubs until a compliant data source is selected.
- Odds snapshots are recorded from provider runner odds when available, but live odds polling is not implemented yet.
- Results and tips tables are prepared for later strategy testing, but imports are currently stubbed.
- The scheduled job checks once per minute while the Node process is running. On shared hosting, prefer manual import unless you have confirmed the process model is reliable.

## License

ISC

---

**Remember: Gambling involves risk. Bet responsibly.**
