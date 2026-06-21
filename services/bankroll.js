/**
 * Bankroll Management Service
 * Handles deposits, withdrawals, bet stakes, and payouts
 */

const { transactions, bets, settings, stats } = require('../db/database');

/**
 * Get current bankroll
 */
function getBankroll() {
    return transactions.getBankroll();
}

/**
 * Set initial bankroll (only if not already set)
 */
function setInitialBankroll(amount) {
    const isSet = settings.get('initial_bankroll_set');
    
    if (isSet === '1') {
        throw new Error('Initial bankroll already set. Use deposit instead.');
    }
    
    transactions.create({
        type: 'deposit',
        amount: amount,
        description: 'Initial bankroll'
    });
    
    settings.set('initial_bankroll_set', '1');
    
    return getBankroll();
}

/**
 * Deposit funds
 */
function deposit(amount, description = 'Deposit') {
    if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
    }
    
    return transactions.create({
        type: 'deposit',
        amount: amount,
        description
    });
}

/**
 * Withdraw funds
 */
function withdraw(amount, description = 'Withdrawal') {
    if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
    }
    
    const bankroll = getBankroll();
    if (amount > bankroll) {
        throw new Error(`Insufficient funds. Bankroll: $${bankroll}`);
    }
    
    return transactions.create({
        type: 'withdrawal',
        amount: -amount,
        description
    });
}

/**
 * Record bet stake (when placing a bet)
 */
function recordBetStake(betId, totalStake) {
    if (totalStake <= 0) return null;
    
    return transactions.create({
        type: 'bet_stake',
        amount: -totalStake,
        bet_id: betId,
        description: `Bet placed`
    });
}

/**
 * Record payout (when settling a winning bet)
 */
function recordPayout(betId, payoutAmount, description = 'Payout') {
    if (payoutAmount <= 0) return null;
    
    return transactions.create({
        type: 'payout',
        amount: payoutAmount,
        bet_id: betId,
        description
    });
}

/**
 * Make an adjustment (manual correction)
 */
function adjustment(amount, description) {
    return transactions.create({
        type: 'adjustment',
        amount: amount,
        description: description || 'Manual adjustment'
    });
}

/**
 * Settle a bet and record appropriate transactions
 */
function settleBet(betId, result, position = null) {
    const bet = bets.getById(betId);
    if (!bet) throw new Error('Bet not found');
    if (bet.status !== 'pending') throw new Error('Bet already settled');
    
    let status, payoutWin = 0, payoutPlace = 0;
    
    if (result === 'void') {
        // Refund stakes
        status = 'void';
        payoutWin = bet.stake_win;
        payoutPlace = bet.stake_place;
        
        if (payoutWin + payoutPlace > 0) {
            recordPayout(betId, payoutWin + payoutPlace, 'Void refund');
        }
    } else if (result === 'won') {
        // Horse won - collect both win and place payouts
        status = 'won';
        position = 1;
        payoutWin = bet.stake_win * bet.odds_win;
        payoutPlace = bet.stake_place * (bet.odds_place || 0);
        
        if (payoutWin + payoutPlace > 0) {
            recordPayout(betId, payoutWin + payoutPlace, 'Win payout');
        }
    } else if (result === 'placed') {
        // Horse placed (2nd or 3rd) - collect place payout only
        status = 'placed';
        payoutWin = 0;
        payoutPlace = bet.stake_place * (bet.odds_place || 0);
        
        if (payoutPlace > 0) {
            recordPayout(betId, payoutPlace, 'Place payout');
        }
    } else {
        // Lost
        status = 'lost';
        payoutWin = 0;
        payoutPlace = 0;
    }
    
    // Update bet record
    const settledBet = bets.settle(betId, status, position, payoutWin, payoutPlace);
    
    return {
        bet: settledBet,
        profit: (payoutWin + payoutPlace) - (bet.stake_win + bet.stake_place),
        bankroll: getBankroll()
    };
}

/**
 * Get comprehensive bankroll summary
 */
function getSummary() {
    const bankroll = getBankroll();
    const allTransactions = transactions.getAll(1000);
    const bettingStats = stats.getBettingStats();
    const drawdown = stats.getDrawdown();
    
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
function getFilteredStats(startDate = null, endDate = null, state = null, track = null) {
    const bettingStats = stats.getBettingStats(startDate, endDate, state, track);
    
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
function getHistory(days = 30) {
    return stats.getBankrollHistory(days);
}

/**
 * Export transactions to CSV format
 */
function exportTransactionsCSV() {
    const allTransactions = transactions.getAll(10000);
    
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
function exportBetsCSV() {
    const allBets = bets.getAll(10000);
    
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
    getSummary,
    getFilteredStats,
    getHistory,
    exportTransactionsCSV,
    exportBetsCSV
};
