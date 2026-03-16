'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase';
import { getShuffledDeck } from '../../utils/deck';
import { handleShowdown } from '../../utils/gameLogic';

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);
  const [tableState, setTableState] = useState(null);
  const [playersState, setPlayersState] = useState([]);
  
  const [raiseAmount, setRaiseAmount] = useState(10);
  const timerRef = useRef(null);

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

  const startMatch = async (playersToJoin) => {
    const deck = getShuffledDeck();
    const isHeadsUp = playersToJoin.length === 2;
    const firstTurnIndex = isHeadsUp ? 0 : (playersToJoin.length > 2 ? 2 : 0);
    const firstTurnPlayerId = playersToJoin[firstTurnIndex].player_id;

    const { data: tableData, error } = await supabase
      .from('poker_tables')
      .insert([{ status: 'active', player_count: playersToJoin.length, pot: 15, highest_bet: 10, game_stage: 'preflop', current_turn_player_id: firstTurnPlayerId, deck: deck.slice(playersToJoin.length * 2) }])
      .select().single();

    if (error) return console.error(error);

    const playersToInsert = playersToJoin.map((p, index) => {
      const holeCards = [deck[index * 2], deck[index * 2 + 1]];
      let chips = 1000;
      let currentBet = 0;
      if (index === 0) { chips = 995; currentBet = 5; } 
      if (index === 1) { chips = 990; currentBet = 10; } 

      return { table_id: tableData.id, player_id: p.player_id, seat_number: index + 1, chips: chips, current_bet: currentBet, hole_cards: holeCards, status: 'active', has_acted: false };
    });

    await supabase.from('table_players').insert(playersToInsert);
    const playerIds = playersToJoin.map(p => p.player_id);
    await supabase.from('queue').delete().in('player_id', playerIds);
  };

  useEffect(() => {
    if (!userId) return;
    const tableSub = supabase.channel('table_inserts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'table_players' }, (payload) => { if (payload.new.player_id === userId) { setTableId(payload.new.table_id); setInQueue(false); } }).subscribe();

    const queueSub = supabase.channel('queue_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, async () => {
        const { data: currentQueue } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
        if (!currentQueue) return;
        setQueueCount(currentQueue.length);
        if (currentQueue.length >= 5) {
          if (timerRef.current) clearTimeout(timerRef.current);
          if (currentQueue[currentQueue.length - 1].player_id === userId) startMatch(currentQueue.slice(0, 5));
        } else if (currentQueue.length >= 2) {
          if (currentQueue[0].player_id === userId && !timerRef.current) {
            timerRef.current = setTimeout(async () => {
              const { data: finalQueue } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
              startMatch(finalQueue);
            }, 30000);
          }
        } else { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } }
      }).subscribe();
    return () => { supabase.removeChannel(tableSub); supabase.removeChannel(queueSub); };
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
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'poker_tables', filter: `id=eq.${tableId}` }, (payload) => setTableState(payload.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'table_players', filter: `table_id=eq.${tableId}` }, () => {
        supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number').then(({data}) => setPlayersState(data));
      }).subscribe();

    return () => supabase.removeChannel(gameSub);
  }, [tableId]);

  const joinQueue = async () => {
    if (!userId) return alert("Please log in first!");
    await supabase.from('queue').insert([{ player_id: userId }]);
    setInQueue(true);
    const { count } = await supabase.from('queue').select('*', { count: 'exact' });
    setQueueCount(count);
  };

  const processAction = async (actionType, betAmount = 0) => {
    if (!tableState || !playersState.length) return;

    const me = playersState.find(p => p.player_id === userId);
    let myNewChips = me.chips; let myNewBet = me.current_bet; let myNewStatus = me.status;
    let newHighestBet = tableState.highest_bet; let newPot = tableState.pot;
    let myNewHasActed = true;

    if (actionType === 'fold') { myNewStatus = 'folded'; } 
    else if (actionType === 'call' || actionType === 'check') {
      const callAmount = newHighestBet - me.current_bet;
      myNewChips -= callAmount; myNewBet += callAmount; newPot += callAmount;
    } 
    else if (actionType === 'raise') {
      if (betAmount < 1) return alert("You must raise by at least 1 chip!");
      const targetBet = newHighestBet + betAmount;
      const totalToPutIn = targetBet - me.current_bet;
      if (totalToPutIn > myNewChips) return alert("You don't have enough chips for that raise!");

      myNewChips -= totalToPutIn; myNewBet = targetBet; newHighestBet = targetBet; newPot += totalToPutIn;
      await supabase.from('table_players').update({ has_acted: false }).eq('table_id', tableId).neq('player_id', userId);
    }

    await supabase.from('table_players').update({ chips: myNewChips, current_bet: myNewBet, status: myNewStatus, has_acted: myNewHasActed }).eq('id', me.id);

    const futurePlayers = playersState.map(p => {
      if (p.player_id === userId) return { ...p, chips: myNewChips, current_bet: myNewBet, status: myNewStatus, has_acted: myNewHasActed };
      return { ...p, has_acted: actionType === 'raise' ? false : p.has_acted };
    });

    const activePlayers = futurePlayers.filter(p => p.status === 'active');
    const isRoundOver = activePlayers.every(p => p.current_bet === newHighestBet && p.has_acted) && activePlayers.length > 1;
    const isWinnerDetermined = activePlayers.length === 1;

    let newDeck = typeof tableState.deck === 'string' ? JSON.parse(tableState.deck) : tableState.deck;
    let newCommunityCards = typeof tableState.community_cards === 'string' ? JSON.parse(tableState.community_cards) : tableState.community_cards;
    let newStage = tableState.game_stage;
    let nextTurnPlayerId = null;

    if (isWinnerDetermined) {
      newStage = 'showdown';
    } else if (isRoundOver) {
      if (newStage === 'preflop') { newStage = 'flop'; newCommunityCards.push(newDeck.pop(), newDeck.pop(), newDeck.pop()); }
      else if (newStage === 'flop') { newStage = 'turn'; newCommunityCards.push(newDeck.pop()); }
      else if (newStage === 'turn') { newStage = 'river'; newCommunityCards.push(newDeck.pop()); }
      else if (newStage === 'river') { newStage = 'showdown'; }

      await supabase.from('table_players').update({ current_bet: 0, has_acted: false }).eq('table_id', tableId).eq('status', 'active');
      newHighestBet = 0;
      nextTurnPlayerId = activePlayers[0].player_id; 
    } else {
      const myIndex = futurePlayers.findIndex(p => p.player_id === userId);
      for (let i = 1; i < futurePlayers.length; i++) {
        const checkIndex = (myIndex + i) % futurePlayers.length;
        if (futurePlayers[checkIndex].status === 'active') {
          nextTurnPlayerId = futurePlayers[checkIndex].player_id;
          break;
        }
      }
    }

    if (newStage === 'showdown') {
      await handleShowdown(tableId, futurePlayers, newCommunityCards, newPot);
    } else {
      await supabase.from('poker_tables').update({
        pot: newPot, highest_bet: newHighestBet, current_turn_player_id: nextTurnPlayerId,
        game_stage: newStage, deck: newDeck, community_cards: newCommunityCards
      }).eq('id', tableId);
    }
  };

  // === NEXT HAND ENGINE ===
  const startNextHand = async () => {
    if (tableState.game_stage !== 'showdown') return;

    // 1. Fetch current players (excluding those who busted out with < 10 chips)
    const { data: currentPlayers } = await supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number');
    const validPlayers = currentPlayers.filter(p => p.chips >= 10);
    
    if (validPlayers.length < 2) {
      alert("Not enough players with chips to continue the game!");
      return; 
    }

    // 2. Rotate Seats (Seat 1 shifts to the back of the line)
    const sortedPlayers = [...validPlayers].sort((a, b) => a.seat_number - b.seat_number);
    const oldDealer = sortedPlayers.shift();
    sortedPlayers.push(oldDealer);

    const rotatedPlayers = sortedPlayers.map((p, index) => ({
      ...p,
      seat_number: index + 1 // Reassign seats 1 to N sequentially
    }));

    // 3. Deal New Cards & Deduct Blinds
    const deck = getShuffledDeck();
    const isHeadsUp = rotatedPlayers.length === 2;
    const firstTurnIndex = isHeadsUp ? 0 : (rotatedPlayers.length > 2 ? 2 : 0);
    const firstTurnPlayerId = rotatedPlayers[firstTurnIndex].player_id;

    for (let i = 0; i < rotatedPlayers.length; i++) {
      const p = rotatedPlayers[i];
      const holeCards = [deck[i * 2], deck[i * 2 + 1]];
      let chips = p.chips;
      let currentBet = 0;

      if (p.seat_number === 1) { chips -= 5; currentBet = 5; } // Small Blind
      if (p.seat_number === 2) { chips -= 10; currentBet = 10; } // Big Blind

      await supabase.from('table_players').update({
        seat_number: p.seat_number, hole_cards: holeCards, chips: chips, current_bet: currentBet, status: 'active', has_acted: false
      }).eq('id', p.id);
    }

    // 4. Reset the Master Table State
    await supabase.from('poker_tables').update({
      pot: 15, highest_bet: 10, game_stage: 'preflop', community_cards: [],
      deck: deck.slice(rotatedPlayers.length * 2), current_turn_player_id: firstTurnPlayerId
    }).eq('id', tableId);
  };

  const parseJSON = (data) => typeof data === 'string' ? JSON.parse(data) : (data || []);

  if (tableId && tableState) {
    const myPlayer = playersState.find(p => p.player_id === userId);
    const opponents = playersState.filter(p => p.player_id !== userId);
    const isMyTurn = tableState.current_turn_player_id === userId && tableState.game_stage !== 'showdown';
    const myHoleCards = myPlayer ? parseJSON(myPlayer.hole_cards) : [];
    const communityCards = parseJSON(tableState.community_cards);
    const canCheck = myPlayer && tableState.highest_bet === myPlayer.current_bet;

    return (
      <div className="flex flex-col items-center justify-between min-h-screen bg-green-800 text-white py-12 px-4">
        
        {tableState.game_stage === 'showdown' && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-black/90 p-8 rounded-2xl border-4 border-yellow-500 z-50 text-center animate-bounce shadow-2xl">
            <h2 className="text-4xl font-bold text-yellow-400 mb-2">SHOWDOWN</h2>
            <p className="text-xl">Winner takes the pot!</p>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-8 mb-8">
          {opponents.map((opp, i) => (
            <div key={i} className={`bg-green-900 p-4 rounded-lg shadow-xl text-center border-2 ${tableState.current_turn_player_id === opp.player_id && tableState.game_stage !== 'showdown' ? 'border-yellow-400' : 'border-green-700'}`}>
              <div className="flex justify-between items-center mb-1">
                <p className="text-sm text-neutral-400">Seat {opp.seat_number}</p>
                {opp.seat_number === 1 && <span className="bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded">SB</span>}
                {opp.seat_number === 2 && <span className="bg-purple-800 text-white text-[10px] px-2 py-0.5 rounded">BB</span>}
              </div>
              <p className="font-bold">Chips: {opp.chips}</p>
              {opp.current_bet > 0 && <p className="text-xs mt-1 text-yellow-400">Bet: {opp.current_bet}</p>}
              {opp.status === 'folded' && <p className="text-xs mt-1 text-red-400 font-bold">FOLDED</p>}
              
              {tableState.game_stage === 'showdown' && opp.status !== 'folded' && (
                <div className="flex gap-1 mt-2 justify-center">
                  {parseJSON(opp.hole_cards).map((card, index) => (
                    <div key={index} className="bg-white text-black w-8 h-12 flex items-center justify-center text-sm font-bold rounded shadow">{card}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center mb-8">
          <div className="bg-green-900/50 px-8 py-4 rounded-full mb-6 border border-green-700">
            <h2 className="text-2xl font-bold text-yellow-400">Pot: {tableState.pot}</h2>
            <p className="text-center text-sm text-neutral-300 uppercase tracking-widest">{tableState.game_stage}</p>
          </div>
          
          <div className="flex gap-2 min-h-[6rem]">
            {communityCards.length > 0 ? (
              communityCards.map((card, index) => (
                <div key={index} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded shadow-lg border-2 border-neutral-300">
                  {card}
                </div>
              ))
            ) : (
              <div className="text-neutral-400 italic mt-4">Preflop</div>
            )}
          </div>
        </div>

        {myPlayer && (
          <div className={`w-full max-w-2xl bg-neutral-900 p-6 rounded-t-2xl shadow-2xl border-t-4 ${isMyTurn ? 'border-yellow-400' : 'border-neutral-700'}`}>
            <div className="flex justify-between items-end">
              <div>
                <div className="flex gap-2 items-center mb-2">
                  <p className="text-sm text-neutral-400">My Stack: <span className="text-white font-bold">{myPlayer.chips}</span></p>
                  {myPlayer.seat_number === 1 && <span className="bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded">SB</span>}
                  {myPlayer.seat_number === 2 && <span className="bg-purple-800 text-white text-[10px] px-2 py-0.5 rounded">BB</span>}
                </div>
                <div className="flex gap-2">
                  {myHoleCards.map((card, index) => (
                    <div key={index} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded shadow-lg border-2 border-blue-500">
                      {card}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-end gap-3">
                {tableState.game_stage === 'showdown' ? (
                  /* SHOWDOWN UI - Only Seat 1 can trigger the next hand */
                  <div className="flex flex-col items-end">
                    {myPlayer.seat_number === 1 ? (
                      <button onClick={startNextHand} className="bg-purple-600 hover:bg-purple-700 px-8 py-4 rounded-xl font-bold transition-colors animate-pulse text-xl shadow-lg border-2 border-purple-400">
                        Deal Next Hand
                      </button>
                    ) : (
                      <p className="text-neutral-400 italic px-4 py-2 border-2 border-neutral-700 rounded bg-neutral-800">
                        Waiting for Dealer (Seat 1) to start next hand...
                      </p>
                    )}
                  </div>
                ) : (
                  /* REGULAR PLAYING UI */
                  <>
                    {isMyTurn ? (
                      <div className="text-yellow-400 font-bold mb-1 animate-pulse">Your Turn!</div>
                    ) : (
                      <div className="text-neutral-500 font-bold mb-1">Waiting for turn...</div>
                    )}
                    
                    <div className="flex gap-3">
                      <button onClick={() => processAction('fold')} disabled={!isMyTurn} className="bg-red-600 hover:bg-red-700 disabled:opacity-50 px-6 py-3 rounded font-bold transition-colors">Fold</button>
                      {canCheck ? (
                        <button onClick={() => processAction('check')} disabled={!isMyTurn} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 px-6 py-3 rounded font-bold transition-colors">Check</button>
                      ) : (
                        <button onClick={() => processAction('call')} disabled={!isMyTurn} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-6 py-3 rounded font-bold transition-colors">
                          Call {tableState.highest_bet - myPlayer.current_bet > 0 ? tableState.highest_bet - myPlayer.current_bet : ''}
                        </button>
                      )}
                      <div className="flex overflow-hidden rounded shadow-lg">
                        <button onClick={() => processAction('raise', raiseAmount)} disabled={!isMyTurn} className="bg-yellow-500 hover:bg-yellow-600 text-black disabled:opacity-50 px-6 py-3 font-bold transition-colors">
                          Raise By
                        </button>
                        <input type="number" min="1" value={raiseAmount} onChange={(e) => setRaiseAmount(Number(e.target.value))} disabled={!isMyTurn} className="w-20 px-2 text-black outline-none border-l-2 border-yellow-600 disabled:opacity-50" />
                      </div>
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white p-4">
      <div className="bg-neutral-800 p-8 rounded shadow-md w-full max-w-sm text-center">
        <h1 className="text-3xl font-bold mb-6">Texas Hold'em</h1>
        {!inQueue ? (
          <button onClick={joinQueue} className="w-full bg-blue-600 hover:bg-blue-700 py-3 rounded font-bold text-xl transition-colors">Play Now</button>
        ) : (
          <div><div className="animate-pulse text-yellow-400 text-xl font-bold mb-4">Searching for table...</div></div>
        )}
      </div>
    </div>
  );
}