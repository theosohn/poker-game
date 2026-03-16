'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase';
import { getShuffledDeck } from '../../utils/deck';
import { handleShowdown } from '../../utils/gameLogic';

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [countdown, setCountdown] = useState(null);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);
  const [tableState, setTableState] = useState(null);
  const [playersState, setPlayersState] = useState([]);
  const [raiseAmount, setRaiseAmount] = useState(10);
  
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

  // HEARTBEAT & CLEANUP: Runs every 5 seconds to keep you alive or kick ghosts
  useEffect(() => {
    if (!tableId || !userId) return;

    const interval = setInterval(async () => {
      // 1. Send my heartbeat
      await supabase.from('table_players').update({ last_heartbeat: new Date().toISOString() }).eq('player_id', userId);

      // 2. Check for ghosts (players who haven't updated in 15+ seconds)
      const fifteenSecondsAgo = new Date(Date.now() - 15000).toISOString();
      const { data: ghosts } = await supabase.from('table_players')
        .select('*')
        .eq('table_id', tableId)
        .lt('last_heartbeat', fifteenSecondsAgo);

      if (ghosts && ghosts.length > 0) {
        ghosts.forEach(g => ghostPlayer(g.player_id));
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [tableId, userId]);

  const ghostPlayer = async (ghostId) => {
    // Fold the player so they don't block the turn, and set chips to 0 so startNextHand skips them
    await supabase.from('table_players').update({ status: 'folded', chips: 0 }).eq('player_id', ghostId);
    // If it was the ghost's turn, we need to pass it
    if (tableState?.current_turn_player_id === ghostId) {
      processAction('check', 0, ghostId);
    }
  };

  const startMatch = async (playersToJoin) => {
    const deck = getShuffledDeck();
    const isHeadsUp = playersToJoin.length === 2;
    const firstTurnIndex = isHeadsUp ? 0 : (playersToJoin.length > 2 ? 2 : 0);
    const firstTurnPlayerId = playersToJoin[firstTurnIndex].player_id;

    const { data: tableData } = await supabase
      .from('poker_tables')
      .insert([{ status: 'active', player_count: playersToJoin.length, pot: 15, highest_bet: 10, game_stage: 'preflop', current_turn_player_id: firstTurnPlayerId, deck: deck.slice(playersToJoin.length * 2) }])
      .select().single();

    const playersToInsert = playersToJoin.map((p, index) => ({
      table_id: tableData.id, player_id: p.player_id, seat_number: index + 1, chips: 1000, current_bet: (index === 0 ? 5 : (index === 1 ? 10 : 0)),
      hole_cards: [deck[index * 2], deck[index * 2 + 1]], status: 'active', has_acted: false
    }));

    await supabase.from('table_players').insert(playersToInsert);
    await supabase.from('queue').delete().in('player_id', playersToJoin.map(p => p.player_id));
  };

  const leaveTable = async (isIntentional = true) => {
    if (!tableId || !userId) return;
    if (isIntentional && !window.confirm("Leave table? Current bet stays in pot.")) return;

    // Delete me from the table players completely so I'm not in future hands
    await supabase.from('table_players').delete().eq('player_id', userId);
    
    // Check if table should close
    const { data: remains } = await supabase.from('table_players').select('*').eq('table_id', tableId);
    if (!remains || remains.length < 2) {
      await supabase.from('poker_tables').delete().eq('id', tableId);
    }

    setTableId(null);
    setTableState(null);
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
            let seconds = 15;
            setCountdown(seconds);
            countdownInterval.current = setInterval(() => {
              seconds -= 1;
              setCountdown(seconds);
              if (seconds <= 0) {
                clearInterval(countdownInterval.current);
                countdownInterval.current = null;
                if (q[0].player_id === userId) startMatch(q);
              }
            }, 1000);
          }
        } else {
          clearInterval(countdownInterval.current);
          countdownInterval.current = null;
          setCountdown(null);
        }
      }).subscribe();
    return () => { clearInterval(countdownInterval.current); supabase.removeChannel(qSub); };
  }, [userId]);

  useEffect(() => {
    if (!tableId) return;
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
        setTableId(null);
        setTableState(null);
      }).subscribe();
    return () => supabase.removeChannel(gameSub);
  }, [tableId]);

  const processAction = async (actionType, betAmount = 0, actingUserId = userId) => {
    if (!tableState || !playersState.length) return;
    const actor = playersState.find(p => p.player_id === actingUserId);
    if (!actor) return;

    let nChips = actor.chips; let nBet = actor.current_bet; let nStatus = actor.status;
    let nHigh = tableState.highest_bet; let nPot = tableState.pot;

    if (actionType === 'fold') nStatus = 'folded';
    else if (actionType === 'call' || actionType === 'check') {
      const diff = nHigh - nBet; nChips -= diff; nBet += diff; nPot += diff;
    } else if (actionType === 'raise') {
      const target = nHigh + betAmount; const diff = target - nBet;
      nChips -= diff; nBet = target; nHigh = target; nPot += diff;
      await supabase.from('table_players').update({ has_acted: false }).eq('table_id', tableId).neq('player_id', actingUserId);
    }

    await supabase.from('table_players').update({ chips: nChips, current_bet: nBet, status: nStatus, has_acted: true }).eq('player_id', actingUserId);

    const fPlayers = playersState.map(p => p.player_id === actingUserId ? { ...p, chips: nChips, current_bet: nBet, status: nStatus, has_acted: true } : { ...p, has_acted: actionType === 'raise' ? false : p.has_acted });
    const active = fPlayers.filter(p => p.status === 'active');
    const isRoundOver = active.every(p => p.current_bet === nHigh && p.has_acted) && active.length > 1;
    const isWin = active.length === 1;

    let nDeck = typeof tableState.deck === 'string' ? JSON.parse(tableState.deck) : tableState.deck;
    let nComm = typeof tableState.community_cards === 'string' ? JSON.parse(tableState.community_cards) : tableState.community_cards;
    let nStage = tableState.game_stage;
    let nTurn = null;

    if (isWin) nStage = 'showdown';
    else if (isRoundOver) {
      if (nStage === 'preflop') { nStage = 'flop'; nComm.push(nDeck.pop(), nDeck.pop(), nDeck.pop()); }
      else if (nStage === 'flop') { nStage = 'turn'; nComm.push(nDeck.pop()); }
      else if (nStage === 'turn') { nStage = 'river'; nComm.push(nDeck.pop()); }
      else if (nStage === 'river') nStage = 'showdown';
      await supabase.from('table_players').update({ current_bet: 0, has_acted: false }).eq('table_id', tableId).eq('status', 'active');
      nHigh = 0; nTurn = active[0].player_id;
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

  const parseJSON = (d) => typeof d === 'string' ? JSON.parse(d) : (d || []);

  if (tableId && tableState) {
    const me = playersState.find(p => p.player_id === userId);
    const opps = playersState.filter(p => p.player_id !== userId && p.chips > 0);
    const myTurn = tableState.current_turn_player_id === userId && tableState.game_stage !== 'showdown';

    return (
      <div className="flex flex-col items-center justify-between min-h-screen bg-green-800 text-white py-12 px-4 relative">
        <button onClick={() => leaveTable(true)} className="absolute top-4 left-4 bg-red-800 p-2 rounded font-bold">Leave Table</button>
        {tableState.game_stage === 'showdown' && <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/90 p-8 rounded-2xl border-4 border-yellow-500 z-50 text-center animate-bounce">SHOWDOWN</div>}
        <div className="flex flex-wrap justify-center gap-8 mb-8 mt-12">
          {opps.map((o, i) => (
            <div key={i} className={`bg-green-900 p-4 rounded-lg border-2 ${tableState.current_turn_player_id === o.player_id ? 'border-yellow-400' : 'border-green-700'}`}>
              <p>Seat {o.seat_number} {o.seat_number === 1 ? 'SB' : o.seat_number === 2 ? 'BB' : ''}</p>
              <p className="font-bold">Chips: {o.chips}</p>
              {o.current_bet > 0 && <p className="text-yellow-400">Bet: {o.current_bet}</p>}
              {tableState.game_stage === 'showdown' && <div className="flex gap-1 mt-1">{parseJSON(o.hole_cards).map(c => <div key={c} className="bg-white text-black p-1 rounded text-xs">{c}</div>)}</div>}
            </div>
          ))}
        </div>
        <div className="text-center bg-green-900/50 p-6 rounded-full border border-green-700">
          <h2 className="text-2xl font-bold text-yellow-400">Pot: {tableState.pot}</h2>
          <p>{tableState.game_stage}</p>
          <div className="flex gap-2 mt-2">{parseJSON(tableState.community_cards).map(c => <div key={c} className="bg-white text-black w-12 h-16 flex items-center justify-center font-bold rounded">{c}</div>)}</div>
        </div>
        {me && (
          <div className={`w-full max-w-2xl bg-neutral-900 p-6 rounded-t-2xl border-t-4 ${myTurn ? 'border-yellow-400' : 'border-neutral-700'}`}>
            <div className="flex justify-between items-end">
              <div>
                <p>Chips: {me.chips} {me.seat_number === 1 ? 'SB' : me.seat_number === 2 ? 'BB' : ''}</p>
                <div className="flex gap-2 mt-2">{parseJSON(me.hole_cards).map(c => <div key={c} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded">{c}</div>)}</div>
              </div>
              <div className="flex flex-col items-end gap-3">
                {tableState.game_stage === 'showdown' ? (me.seat_number === 1 && <button onClick={() => startNextHand()} className="bg-purple-600 p-4 rounded font-bold">Next Hand</button>) : (
                  <div className="flex gap-2">
                    <button onClick={() => processAction('fold')} disabled={!myTurn} className="bg-red-600 p-3 rounded">Fold</button>
                    <button onClick={() => processAction(tableState.highest_bet === me.current_bet ? 'check' : 'call')} disabled={!myTurn} className="bg-blue-600 p-3 rounded">{tableState.highest_bet === me.current_bet ? 'Check' : `Call ${tableState.highest_bet - me.current_bet}`}</button>
                    <input type="number" value={raiseAmount} onChange={e => setRaiseAmount(Number(e.target.value))} className="w-16 text-black rounded p-2" />
                    <button onClick={() => processAction('raise', raiseAmount)} disabled={!myTurn} className="bg-yellow-500 text-black p-3 rounded">Raise By</button>
                  </div>
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
        {!inQueue ? <button onClick={() => { supabase.from('queue').insert([{ player_id: userId }]); setInQueue(true); }} className="bg-blue-600 p-4 w-full rounded font-bold">Play Now</button> : (
          <div>
            <p className="text-xl mb-2">Players: {queueCount}</p>
            {countdown !== null && <p className="text-4xl font-bold text-yellow-400">Starting in: {countdown}s</p>}
          </div>
        )}
      </div>
    </div>
  );
}