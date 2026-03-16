'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase';
import { getShuffledDeck } from '../../utils/deck';
import { handleShowdown } from '../../utils/gameLogic';

const getCardImageUrl = (card) => {
  if (!card) return '';
  const value = card[0] === 'T' ? '0' : card[0].toUpperCase();
  const suit = card[1].toUpperCase();
  return `https://deckofcardsapi.com/static/img/${value}${suit}.png`;
};

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [countdown, setCountdown] = useState(null);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);
  const [tableState, setTableState] = useState(null);
  const [playersState, setPlayersState] = useState([]);
  const [raiseAmount, setRaiseAmount] = useState(10);
  
  // SEQUENCE STATE FOR UI ANIMATION
  const [showdownState, setShowdownState] = useState({ potIndex: 0, isGap: false, finished: false });
  
  const timerRef = useRef(null);
  const countdownInterval = useRef(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setUserId(user.id);
        const { data } = await supabase.from('table_players').select('*').eq('player_id', user.id).single();
        if (data) setTableId(data.table_id);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (!tableId || !userId) return;
    const interval = setInterval(async () => {
      await supabase.from('table_players').update({ last_heartbeat: new Date().toISOString() }).eq('player_id', userId);
      const fifteenSecondsAgo = new Date(Date.now() - 15000).toISOString();
      const { data: ghosts } = await supabase.from('table_players').select('*').eq('table_id', tableId).lt('last_heartbeat', fifteenSecondsAgo);
      if (ghosts && ghosts.length > 0) ghosts.forEach(g => ghostPlayer(g.player_id));
    }, 5000);
    return () => clearInterval(interval);
  }, [tableId, userId]);

  const ghostPlayer = async (ghostId) => {
    await supabase.from('table_players').update({ status: 'folded', chips: 0 }).eq('player_id', ghostId);
    if (tableState?.current_turn_player_id === ghostId) processAction('check', 0, ghostId);
  };

  const startMatch = async (playersToJoin) => {
    const deck = getShuffledDeck();
    const isHeadsUp = playersToJoin.length === 2;
    const firstTurnPlayerId = playersToJoin[isHeadsUp ? 0 : (playersToJoin.length > 2 ? 2 : 0)].player_id;

    const { data: tableData } = await supabase
      .from('poker_tables')
      .insert([{ status: 'active', player_count: playersToJoin.length, pot: 15, highest_bet: 10, game_stage: 'preflop', current_turn_player_id: firstTurnPlayerId, deck: deck.slice(playersToJoin.length * 2), showdown_results: '[]' }])
      .select().single();

    const playersToInsert = playersToJoin.map((p, index) => {
      let c = 1000, b = 0, hc = 0;
      if (index === 0) { c = 995; b = 5; hc = 5; }
      if (index === 1) { c = 990; b = 10; hc = 10; }
      return { table_id: tableData.id, player_id: p.player_id, seat_number: index + 1, chips: c, current_bet: b, hand_contribution: hc, hole_cards: [deck[index * 2], deck[index * 2 + 1]], status: 'active', has_acted: false };
    });

    await supabase.from('table_players').insert(playersToInsert);
    await supabase.from('queue').delete().in('player_id', playersToJoin.map(p => p.player_id));
  };

  const leaveTable = async (isIntentional = true) => {
    if (!tableId || !userId) return;
    if (isIntentional && !window.confirm("Leave table? Current bet stays in pot.")) return;
    await supabase.from('table_players').delete().eq('player_id', userId);
    const { data: remains } = await supabase.from('table_players').select('*').eq('table_id', tableId);
    if (!remains || remains.length < 2) await supabase.from('poker_tables').delete().eq('id', tableId);
    setTableId(null); setTableState(null);
  };

  useEffect(() => {
    if (!userId) return;
    const qSub = supabase.channel('queue_changes').on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, async () => {
        const { data: q } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
        setQueueCount(q?.length || 0);
        if (q?.length >= 5) {
          clearInterval(countdownInterval.current);
          if (q[q.length - 1].player_id === userId) startMatch(q.slice(0, 5));
        } else if (q?.length >= 2) {
          if (!countdownInterval.current) {
            let seconds = 15; setCountdown(seconds);
            countdownInterval.current = setInterval(() => {
              seconds -= 1; setCountdown(seconds);
              if (seconds <= 0) {
                clearInterval(countdownInterval.current); countdownInterval.current = null;
                if (q[0].player_id === userId) startMatch(q);
              }
            }, 1000);
          }
        } else { clearInterval(countdownInterval.current); countdownInterval.current = null; setCountdown(null); }
      }).subscribe();
    return () => { clearInterval(countdownInterval.current); supabase.removeChannel(qSub); };
  }, [userId]);

  useEffect(() => {
    if (!tableId) return;
    const handleUnload = () => leaveTable(false);
    window.addEventListener('beforeunload', handleUnload);

    const fetchGame = async () => {
      const { data: t } = await supabase.from('poker_tables').select('*').eq('id', tableId).single();
      setTableState(t);
      const { data: p } = await supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number');
      setPlayersState(p);
    };
    fetchGame();

    const gameSub = supabase.channel('game_updates')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'poker_tables', filter: `id=eq.${tableId}` }, (p) => setTableState(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_players', filter: `table_id=eq.${tableId}` }, () => {
        supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number').then(({data}) => setPlayersState(data));
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'poker_tables', filter: `id=eq.${tableId}` }, () => {
        setTableId(null); setTableState(null);
      }).subscribe();
    return () => { supabase.removeChannel(gameSub); window.removeEventListener('beforeunload', handleUnload); };
  }, [tableId, userId]);

  // SEQUENTIAL SHOWDOWN ANIMATION ENGINE
  useEffect(() => {
    if (tableState?.game_stage === 'showdown' && tableState?.showdown_results) {
        const results = parseJSON(tableState.showdown_results);
        if (results.length === 0) return;

        let currentIdx = 0;
        setShowdownState({ potIndex: currentIdx, isGap: false, finished: false });

        const runSequence = () => {
            setTimeout(() => {
                setShowdownState(prev => ({ ...prev, isGap: true }));
                setTimeout(() => {
                    currentIdx++;
                    if (currentIdx < results.length) {
                        setShowdownState({ potIndex: currentIdx, isGap: false, finished: false });
                        runSequence();
                    } else {
                        setShowdownState({ potIndex: currentIdx - 1, isGap: false, finished: true });
                    }
                }, 2000); // 2s gap
            }, 3000); // 3s display
        };
        runSequence();
    } else {
        setShowdownState({ potIndex: 0, isGap: false, finished: false });
    }
  }, [tableState?.showdown_results, tableState?.game_stage]);

  const processAction = async (actionType, betAmount = 0, actingUserId = userId) => {
    if (!tableState || !playersState.length) return;
    const actor = playersState.find(p => p.player_id === actingUserId);
    if (!actor) return;

    let nChips = actor.chips; let nBet = actor.current_bet; let nStatus = actor.status;
    let nContrib = actor.hand_contribution || 0;
    let nHigh = tableState.highest_bet; let nPot = tableState.pot;

    if (actionType === 'fold') nStatus = 'folded';
    else if (actionType === 'call' || actionType === 'check') {
      let callAmt = nHigh - nBet;
      if (callAmt >= nChips) { callAmt = nChips; nStatus = 'all-in'; }
      nChips -= callAmt; nBet += callAmt; nPot += callAmt; nContrib += callAmt;
    } else if (actionType === 'raise') {
      const target = nHigh + betAmount; 
      let diff = target - nBet;
      if (diff >= nChips) {
        diff = nChips; nStatus = 'all-in'; nBet += diff;
        if (nBet > nHigh) nHigh = nBet;
      } else {
        nBet = target; nHigh = target;
      }
      nChips -= diff; nPot += diff; nContrib += diff;
      await supabase.from('table_players').update({ has_acted: false }).eq('table_id', tableId).neq('player_id', actingUserId).eq('status', 'active');
    }

    await supabase.from('table_players').update({ chips: nChips, current_bet: nBet, status: nStatus, has_acted: true, hand_contribution: nContrib }).eq('player_id', actingUserId);

    const fPlayers = playersState.map(p => p.player_id === actingUserId ? { ...p, chips: nChips, current_bet: nBet, status: nStatus, has_acted: true, hand_contribution: nContrib } : { ...p, has_acted: actionType === 'raise' ? false : p.has_acted });
    const active = fPlayers.filter(p => p.status === 'active');
    
    // Round is over if active players match high bet OR if 1/0 active players remain (all-ins)
    const isRoundOver = (active.every(p => p.current_bet === nHigh && p.has_acted) && active.length > 1) || active.length <= 1;
    const isWin = fPlayers.filter(p => p.status !== 'folded').length === 1;

    let nDeck = typeof tableState.deck === 'string' ? JSON.parse(tableState.deck) : tableState.deck;
    let nComm = typeof tableState.community_cards === 'string' ? JSON.parse(tableState.community_cards) : tableState.community_cards;
    let nStage = tableState.game_stage;
    let nTurn = null;

    if (isWin) nStage = 'showdown';
    else if (isRoundOver) {
      // Auto-deal remaining cards instantly if 1 or 0 players are active (others all-in)
      if (active.length <= 1) {
         while(nStage !== 'river' && nStage !== 'showdown') {
            if (nStage === 'preflop') { nStage = 'flop'; nComm.push(nDeck.pop(), nDeck.pop(), nDeck.pop()); }
            else if (nStage === 'flop') { nStage = 'turn'; nComm.push(nDeck.pop()); }
            else if (nStage === 'turn') { nStage = 'river'; nComm.push(nDeck.pop()); }
         }
         nStage = 'showdown';
      } else {
         if (nStage === 'preflop') { nStage = 'flop'; nComm.push(nDeck.pop(), nDeck.pop(), nDeck.pop()); }
         else if (nStage === 'flop') { nStage = 'turn'; nComm.push(nDeck.pop()); }
         else if (nStage === 'turn') { nStage = 'river'; nComm.push(nDeck.pop()); }
         else if (nStage === 'river') nStage = 'showdown';
      }
      await supabase.from('table_players').update({ current_bet: 0, has_acted: false }).eq('table_id', tableId).eq('status', 'active');
      nHigh = 0; nTurn = active.length > 0 ? active[0].player_id : null;
    } else {
      const idx = fPlayers.findIndex(p => p.player_id === actingUserId);
      for (let i = 1; i < fPlayers.length; i++) {
        const check = (idx + i) % fPlayers.length;
        if (fPlayers[check].status === 'active') { nTurn = fPlayers[check].player_id; break; }
      }
    }

    if (nStage === 'showdown') await handleShowdown(tableId, fPlayers, nComm, nPot);
    else await supabase.from('poker_tables').update({ pot: nPot, highest_bet: nHigh, current_turn_player_id: nTurn, game_stage: nStage, deck: nDeck, community_cards: nComm }).eq('id', tableId);
  };

  const startNextHand = async () => {
    if (tableState.game_stage !== 'showdown') return;
    const { data: currentPlayers } = await supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number');
    const validPlayers = currentPlayers.filter(p => p.chips > 0);
    if (validPlayers.length < 2) return alert("Not enough players with chips to continue the game!");

    const sortedPlayers = [...validPlayers].sort((a, b) => a.seat_number - b.seat_number);
    const oldDealer = sortedPlayers.shift(); sortedPlayers.push(oldDealer);
    const rotatedPlayers = sortedPlayers.map((p, index) => ({ ...p, seat_number: index + 1 }));

    const deck = getShuffledDeck();
    const firstTurnPlayerId = rotatedPlayers[rotatedPlayers.length === 2 ? 0 : (rotatedPlayers.length > 2 ? 2 : 0)].player_id;

    for (let i = 0; i < rotatedPlayers.length; i++) {
      const p = rotatedPlayers[i];
      let c = p.chips, b = 0, hc = 0;
      if (p.seat_number === 1) { c -= 5; b = 5; hc = 5; } 
      if (p.seat_number === 2) { c -= 10; b = 10; hc = 10; } 
      await supabase.from('table_players').update({ seat_number: p.seat_number, hole_cards: [deck[i * 2], deck[i * 2 + 1]], chips: c, current_bet: b, hand_contribution: hc, status: 'active', has_acted: false }).eq('id', p.id);
    }
    await supabase.from('poker_tables').update({ pot: 15, highest_bet: 10, game_stage: 'preflop', community_cards: [], deck: deck.slice(rotatedPlayers.length * 2), current_turn_player_id: firstTurnPlayerId, showdown_results: '[]' }).eq('id', tableId);
  };

  const parseJSON = (d) => typeof d === 'string' ? JSON.parse(d) : (d || []);

  if (tableId && tableState) {
    const me = playersState.find(p => p.player_id === userId);
    const opps = playersState.filter(p => p.player_id !== userId && p.chips > 0);
    const myTurn = tableState.current_turn_player_id === userId && tableState.game_stage !== 'showdown';
    const myCards = me ? parseJSON(me.hole_cards) : [];
    const commCards = parseJSON(tableState.community_cards);
    const canCheck = me && tableState.highest_bet === me.current_bet;

    // Grab the current pot animation to display
    const sdResults = parseJSON(tableState.showdown_results);
    const currentPotToDisplay = sdResults[showdownState.potIndex];

    return (
      <div className="flex flex-col items-center justify-between min-h-screen bg-green-800 text-white py-12 px-4 relative">
        <button onClick={() => leaveTable(true)} className="absolute top-4 left-4 bg-red-800 p-2 rounded font-bold z-40">Leave Table</button>
        
        {/* NEW SEQUENTIAL SHOWDOWN OVERLAY */}
        {tableState.game_stage === 'showdown' && sdResults.length > 0 && (
            <div className={`absolute top-[40%] left-1/2 -translate-x-1/2 -translate-y-1/2 p-8 rounded-2xl border-4 border-yellow-500 z-50 text-center shadow-2xl min-w-[350px] transition-opacity duration-300 ${showdownState.isGap ? 'opacity-0 bg-transparent border-transparent' : 'opacity-100 bg-black/95 animate-bounce'}`}>
                {!showdownState.isGap && currentPotToDisplay && (() => {
                    const isWinner = currentPotToDisplay.winners.includes(userId);
                    const winnerNames = currentPotToDisplay.winners.map(wId => {
                        if (wId === userId) return "You";
                        const wp = playersState.find(p => p.player_id === wId);
                        return wp ? `Seat ${wp.seat_number}` : "Unknown";
                    }).join(" & ");

                    return (
                        <>
                            <h2 className={`text-4xl font-bold mb-2 ${isWinner ? 'text-yellow-400' : 'text-white'}`}>
                                {isWinner ? "YOU WON!" : `${winnerNames} WINS`}
                            </h2>
                            <p className="text-2xl mb-1 text-green-400 font-bold">
                                {currentPotToDisplay.isMainPot ? "Main Pot" : `Side Pot ${showdownState.potIndex}`}: +{currentPotToDisplay.potSize}
                            </p>
                            <p className="text-xl text-neutral-300 italic">{currentPotToDisplay.winningHandName}</p>
                        </>
                    );
                })()}
            </div>
        )}

        <div className="flex flex-wrap justify-center gap-8 mb-8 mt-12 w-full px-4">
          {opps.map((o, i) => (
            <div key={i} className={`bg-green-900 p-4 rounded-lg border-2 relative ${tableState.current_turn_player_id === o.player_id && tableState.game_stage !== 'showdown' ? 'border-yellow-400' : 'border-green-700'}`}>
              <div className="flex justify-between items-center mb-1">
                <p>Seat {o.seat_number}</p>
                {o.seat_number === 1 && <span className="bg-purple-600 px-2 rounded text-xs">SB</span>}
                {o.seat_number === 2 && <span className="bg-purple-800 px-2 rounded text-xs">BB</span>}
              </div>
              <p className="font-bold">Chips: {o.chips}</p>
              {o.current_bet > 0 && <p className="text-yellow-400">Bet: {o.current_bet}</p>}
              {o.status === 'folded' && <p className="text-red-400 font-bold">FOLDED</p>}
              {o.status === 'all-in' && <p className="text-blue-400 font-bold">ALL-IN</p>}
              {tableState.game_stage === 'showdown' && o.status !== 'folded' && (
                <div className="flex gap-1 mt-2 justify-center">
                    {parseJSON(o.hole_cards).map(c => <img key={c} src={getCardImageUrl(c)} className="w-10 h-14 object-contain" />)}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="text-center bg-green-900/50 p-6 rounded-full border border-green-700">
          <h2 className="text-2xl font-bold text-yellow-400">Pot: {tableState.pot}</h2>
          <p>{tableState.game_stage.toUpperCase()}</p>
          <div className="flex gap-2 min-h-[6rem] mt-2">
            {commCards.map(c => <img key={c} src={getCardImageUrl(c)} className="w-16 h-24 object-contain drop-shadow-xl" />)}
          </div>
        </div>

        {me && (
          <div className={`w-full max-w-2xl bg-neutral-900 p-6 rounded-t-2xl border-t-4 ${myTurn ? 'border-yellow-400' : 'border-neutral-700'}`}>
            <div className="flex justify-between items-end">
              <div>
                <p>Chips: {me.chips} {me.seat_number === 1 && <span className="bg-purple-600 px-2 rounded text-xs">SB</span>} {me.seat_number === 2 && <span className="bg-purple-800 px-2 rounded text-xs">BB</span>}</p>
                <div className="flex gap-2 mt-2">{myCards.map(c => <img key={c} src={getCardImageUrl(c)} className="w-16 h-24 object-contain" />)}</div>
              </div>
              <div className="flex flex-col items-end gap-3">
                {tableState.game_stage === 'showdown' ? (
                  showdownState.finished && me.seat_number === 1 ? (
                    <button onClick={startNextHand} className="bg-purple-600 p-4 rounded font-bold animate-pulse">Deal Next Hand</button>
                  ) : (<p className="text-neutral-500 italic">Waiting for dealer...</p>)
                ) : (
                  <>
                    <p className="font-bold text-yellow-400 mb-1">{myTurn ? "Your Turn!" : ""}</p>
                    <div className="flex gap-2">
                      <button onClick={() => processAction('fold')} disabled={!myTurn} className="bg-red-600 p-3 rounded font-bold disabled:opacity-50">Fold</button>
                      <button onClick={() => processAction(canCheck ? 'check' : 'call')} disabled={!myTurn} className="bg-blue-600 p-3 rounded font-bold disabled:opacity-50">
                        {canCheck ? 'Check' : `Call ${tableState.highest_bet - me.current_bet > me.chips ? 'All-In' : tableState.highest_bet - me.current_bet}`}
                      </button>
                      <input type="number" min="1" value={raiseAmount} onChange={e => setRaiseAmount(Number(e.target.value))} className="w-16 text-black rounded p-2" />
                      <button onClick={() => processAction('raise', raiseAmount)} disabled={!myTurn} className="bg-yellow-500 text-black p-3 rounded font-bold disabled:opacity-50">Raise By</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white">
      <div className="bg-neutral-800 p-8 rounded text-center max-w-sm w-full">
        <h1 className="text-3xl font-bold mb-4">Poker Queue</h1>
        {!inQueue ? <button onClick={joinQueue} className="bg-blue-600 p-4 w-full rounded font-bold">Play Now</button> : (
          <div><p>Players: {queueCount}</p>{countdown !== null && <p className="text-4xl text-yellow-400">Starting: {countdown}s</p>}</div>
        )}
      </div>
    </div>
  );
}