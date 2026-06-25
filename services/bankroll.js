/**
 * Bankroll Management Service
 * Handles deposits, withdrawals, bet stakes, and payouts
 */

const { transactions, bets, settings, stats } = require('../db/database');

const PERIODS = {
    all_time: { label: 'All Time', days: null },
    today: { label: 'Today', days: 0 },
    last_7_days: { label: 'Last 7 days', days: 7 },
    last_month: { label: 'Last month', days: 30 },
    last_quarter: { label: 'Last Quarter', days: 90 },
    last_6_months: { label: 'Last 6 months', days: 183 },
    last_12_months: { label: 'Last 12 months', days: 365 }
};

function formatDateKey(date) {
    return date.toISOString().slice(0, 10);
}

function getPeriodRange(period = 'all_time') {
    const key = PERIODS[period] ? period : 'all_time';
    const config = PERIODS[key];
    if (config.days === null) {
        return { period: key, label: config.label, startDate: null, endDate: null };
    }

    const end = new Date();
    const start = new Date(end);
    if (config.days > 0) {
        start.setDate(start.getDate() - config.days + 1);
    }

    return {
        period: key,
        label: config.label,
        startDate: formatDateKey(start),
        endDate: formatDateKey(end)
    };
}

function isWithinPeriod(value, range) {
    if (!range.startDate && !range.endDate) return true;
    if (!value) return false;
    const date = String(value).slice(0, 10);
    if (range.startDate && date < range.startDate) return false;
    if (range.endDate && date > range.endDate) return false;
    return true;
}

/**
 * Get current bankroll
 */
function getBankroll(userId) {
    return transactions.getBankroll(userId);
}

/**
 * Set initial bankroll (only if not already set)
 */
function setInitialBankroll(amount, userId) {
    const isSet = settings.get('initial_bankroll_set', userId);
    
    if (isSet === '1') {
        throw new Error('Initial bankroll already set. Use deposit instead.');
    }
    
    transactions.create({
        user_id: userId,
        type: 'deposit',
        amount: amount,
        description: 'Initial bankroll'
    });
    
    settings.set('initial_bankroll_set', '1', userId);
    
    return getBankroll(userId);
}

/**
 * Deposit funds
 */
function deposit(amount, description = 'Deposit', userId) {
    if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
    }
    
    return transactions.create({
        user_id: userId,
        type: 'deposit',
        amount: amount,
        description
    });
}

/**
 * Withdraw funds
 */
function withdraw(amount, description = 'Withdrawal', userId) {
    if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
    }
    
    const bankroll = getBankroll(userId);
    if (amount > bankroll) {
        throw new Error(`Insufficient funds. Bankroll: $${bankroll}`);
    }
    
    return transactions.create({
        user_id: userId,
        type: 'withdrawal',
        amount: -amount,
        description
    });
}

/**
 * Record bet stake (when placing a bet)
 */
function recordBetStake(betId, totalStake, userId) {
    if (totalStake <= 0) return null;
    
    return transactions.create({
        user_id: userId,
        type: 'bet_stake',
        amount: -totalStake,
        bet_id: betId,
        description: `Bet placed`
    });
}

/**
 * Record payout (when settling a winning bet)
 */
function recordPayout(betId, payoutAmount, description = 'Payout', userId) {
    if (payoutAmount <= 0) return null;
    
    return transactions.create({
        user_id: userId,
        type: 'payout',
        amount: payoutAmount,
        bet_id: betId,
        description
    });
}

/**
 * Make an adjustment (manual correction)
 */
function adjustment(amount, description, userId) {
    return transactions.create({
        user_id: userId,
        type: 'adjustment',
        amount: amount,
        description: description || 'Manual adjustment'
    });
}

/**
 * Settle a bet and record appropriate transactions
 */
function settleBet(betId, result, position = null, userId) {
    const bet = bets.getById(betId, userId);
    if (!bet) throw new Error('Bet not found');
    if (bet.status !== 'pending') throw new Error('Bet already settled');
    
    let status, payoutWin = 0, payoutPlace = 0;
    
    if (result === 'void') {
        // Refund stakes
        status = 'void';
        payoutWin = bet.stake_win;
        payoutPlace = bet.stake_place;
        
        if (payoutWin + payoutPlace > 0) {
            recordPayout(betId, payoutWin + payoutPlace, 'Void refund', userId);
        }
    } else if (result === 'won') {
        // Horse won - collect both win and place payouts
        status = 'won';
        position = 1;
        payoutWin = bet.stake_win * bet.odds_win;
        payoutPlace = bet.stake_place * (bet.odds_place || 0);
        
        if (payoutWin + payoutPlace > 0) {
            recordPayout(betId, payoutWin + payoutPlace, 'Win payout', userId);
        }
    } else if (result === 'placed') {
        // Horse placed (2nd or 3rd) - collect place payout only
        status = 'placed';
        payoutWin = 0;
        payoutPlace = bet.stake_place * (bet.odds_place || 0);
        
        if (payoutPlace > 0) {
            recordPayout(betId, payoutPlace, 'Place payout', userId);
        }
    } else {
        // Lost
        status = 'lost';
        payoutWin = 0;
        payoutPlace = 0;
    }
    
    // Update bet record
    const settledBet = bets.settle(betId, status, position, payoutWin, payoutPlace, userId);
    
    return {
        bet: settledBet,
        profit: (payoutWin + payoutPlace) - (bet.stake_win + bet.stake_place),
        bankroll: getBankroll(userId)
    };
}

/**
 * Get comprehensive bankroll summary
 */
function getSummary(userId, period = 'all_time') {
    const range = getPeriodRange(period);
    const bankroll = getBankroll(userId);
    const allTransactions = transactions.getAll(10000, userId)
        .filter(tx => isWithinPeriod(tx.created_at, range));
    const bettingStats = stats.getBettingStats(range.startDate, range.endDate, null, null, userId);
    const drawdown = stats.getDrawdown(userId);
    
    // Calculate totals by type
    const totals = {
        deposits: 0,
        withdrawals: 0,
        stakes: 0,
        payouts: 0,
        adjustments: 0
    };
    
    for (const tx of allTransactions) {
        switch (tx.type) {
            case 'deposit': totals.deposits += tx.amount; break;
            case 'withdrawal': totals.withdrawals += Math.abs(tx.amount); break;
            case 'bet_stake': totals.stakes += Math.abs(tx.amount); break;
            case 'payout': totals.payouts += tx.amount; break;
            case 'adjustment': totals.adjustments += tx.amount; break;
        }
    }
    
    // Calculate ROI
    const netProfit = totals.payouts - totals.stakes;
    const roi = totals.stakes > 0 ? (netProfit / totals.stakes) : 0;
    
    // Calculate strike rates
    const totalBets = bettingStats.total_bets || 0;
    const winRate = totalBets > 0 ? (bettingStats.wins || 0) / totalBets : 0;
    const placeRate = totalBets > 0 ? ((bettingStats.wins || 0) + (bettingStats.places || 0)) / totalBets : 0;
    
    return {
        bankroll,
        period: range,
        totals,
        netProfit,
        roi,
        roiPercent: roi * 100,
        betting: {
            totalBets,
            wins: bettingStats.wins || 0,
            places: bettingStats.places || 0,
            losses: bettingStats.losses || 0,
            winRate,
            placeRate,
            winRatePercent: winRate * 100,
            placeRatePercent: placeRate * 100
        },
        drawdown: {
            max: drawdown.max_drawdown,
            current: drawdown.current_drawdown,
            maxPercent: drawdown.max_drawdown * 100,
            currentPercent: drawdown.current_drawdown * 100,
            peak: drawdown.peak
        }
    };
}

/**
 * Get filtered stats by date range and/or track
 */
function getFilteredStats(startDate = null, endDate = null, state = null, track = null, userId) {
    const bettingStats = stats.getBettingStats(startDate, endDate, state, track, userId);
    
    const totalBets = bettingStats.total_bets || 0;
    const winRate = totalBets > 0 ? (bettingStats.wins || 0) / totalBets : 0;
    const placeRate = totalBets > 0 ? ((bettingStats.wins || 0) + (bettingStats.places || 0)) / totalBets : 0;
    const roi = bettingStats.total_staked > 0 ? 
        (bettingStats.profit || 0) / bettingStats.total_staked : 0;
    
    return {
        totalBets,
        wins: bettingStats.wins || 0,
        places: bettingStats.places || 0,
        losses: bettingStats.losses || 0,
        totalStaked: bettingStats.total_staked || 0,
        totalReturned: bettingStats.total_returned || 0,
        profit: bettingStats.profit || 0,
        roi,
        roiPercent: roi * 100,
        winRate,
        placeRate,
        winRatePercent: winRate * 100,
        placeRatePercent: placeRate * 100
    };
}

/**
 * Get bankroll history for charting
 */
function getHistory(days = 30, userId) {
    return stats.getBankrollHistory(days, userId);
}

/**
 * Export transactions to CSV format
 */
function exportTransactionsCSV(userId, period = 'all_time') {
    const range = getPeriodRange(period);
    const allTransactions = transactions.getAll(10000, userId)
        .filter(tx => isWithinPeriod(tx.created_at, range));
    
    const headers = ['ID', 'Date', 'Type', 'Amount', 'Bet ID', 'Description'];
    const rows = allTransactions.map(tx => [
        tx.id,
        tx.created_at,
        tx.type,
        tx.amount,
        tx.bet_id || '',
        tx.description || ''
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    return csv;
}

/**
 * Export bets to CSV format
 */
function exportBetsCSV(userId, period = 'all_time') {
    const range = getPeriodRange(period);
    const allBets = bets.getAll(10000, userId)
        .filter(b => isWithinPeriod(b.date || b.placed_at, range));
    
    const headers = [
        'ID', 'Date', 'Track', 'Race', 'Horse', 'Saddle',
        'Stake Win', 'Stake Place', 'Odds Win', 'Odds Place',
        'Status', 'Position', 'Payout Win', 'Payout Place', 'Profit'
    ];
    
    const rows = allBets.map(b => {
        const profit = (b.payout_win + b.payout_place) - (b.stake_win + b.stake_place);
        return [
            b.id,
            b.date,
            b.track,
            b.race_no,
            b.horse_name,
            b.saddle_no,
            b.stake_win,
            b.stake_place,
            b.odds_win,
            b.odds_place,
            b.status,
            b.result_position || '',
            b.payout_win,
            b.payout_place,
            profit
        ];
    });
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    return csv;
}

module.exports = {
    getBankroll,
    setInitialBankroll,
    deposit,
    withdraw,
    recordBetStake,
    recordPayout,
    adjustment,
    settleBet,
    getPeriodRange,
    getSummary,
    getFilteredStats,
    getHistory,
    exportTransactionsCSV,
    exportBetsCSV
};
