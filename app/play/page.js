'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase';
import { getShuffledDeck } from '../../utils/deck';

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);
  
  // Live Game State
  const [tableState, setTableState] = useState(null);
  const [playersState, setPlayersState] = useState([]);
  
  const timerRef = useRef(null);

  // 1. Get user and existing table
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

  // 2. The Matchmaker & DEALER Engine
  const startMatch = async (playersToJoin) => {
    const deck = getShuffledDeck();
    
    // Determine turns (Seat 1 is Dealer/Small Blind, Seat 2 is Big Blind)
    const isHeadsUp = playersToJoin.length === 2;
    const firstTurnIndex = isHeadsUp ? 0 : (playersToJoin.length > 2 ? 2 : 0);
    const firstTurnPlayerId = playersToJoin[firstTurnIndex].player_id;

    // A. Create the poker table with blinds and remaining deck
    const { data: tableData, error } = await supabase
      .from('poker_tables')
      .insert([{ 
        status: 'active', 
        player_count: playersToJoin.length,
        pot: 15, // 5 (SB) + 10 (BB)
        highest_bet: 10,
        game_stage: 'preflop',
        current_turn_player_id: firstTurnPlayerId,
        deck: deck.slice(playersToJoin.length * 2) // Save the undealt cards
      }])
      .select()
      .single();

    if (error) return console.error(error);

    // B. Deal cards and deduct blinds
    const playersToInsert = playersToJoin.map((p, index) => {
      const holeCards = [deck[index * 2], deck[index * 2 + 1]];
      let chips = 1000;
      let currentBet = 0;

      if (index === 0) { chips = 995; currentBet = 5; } // Small Blind
      if (index === 1) { chips = 990; currentBet = 10; } // Big Blind

      return {
        table_id: tableData.id,
        player_id: p.player_id,
        seat_number: index + 1,
        chips: chips,
        current_bet: currentBet,
        hole_cards: holeCards, 
        status: 'active'
      };
    });

    await supabase.from('table_players').insert(playersToInsert);

    // C. Remove from queue
    const playerIds = playersToJoin.map(p => p.player_id);
    await supabase.from('queue').delete().in('player_id', playerIds);
  };

  // 3. Queue Listeners (Same as before)
  useEffect(() => {
    if (!userId) return;

    const tableSub = supabase.channel('table_inserts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'table_players' }, (payload) => {
        if (payload.new.player_id === userId) {
          setTableId(payload.new.table_id);
          setInQueue(false);
        }
      }).subscribe();

    const queueSub = supabase.channel('queue_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, async () => {
        const { data: currentQueue } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
        if (!currentQueue) return;
        setQueueCount(currentQueue.length);

        if (currentQueue.length >= 5) {
          if (timerRef.current) clearTimeout(timerRef.current);
          if (currentQueue[currentQueue.length - 1].player_id === userId) {
            startMatch(currentQueue.slice(0, 5));
          }
        } else if (currentQueue.length >= 2) {
          if (currentQueue[0].player_id === userId && !timerRef.current) {
            timerRef.current = setTimeout(async () => {
              const { data: finalQueue } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
              startMatch(finalQueue);
            }, 30000);
          }
        } else {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        }
      }).subscribe();

    return () => { supabase.removeChannel(tableSub); supabase.removeChannel(queueSub); };
  }, [userId]);

  // 4. LIVE GAME LISTENERS (New!)
  useEffect(() => {
    if (!tableId) return;

    // Fetch initial game state
    const fetchGame = async () => {
      const { data: t } = await supabase.from('poker_tables').select('*').eq('id', tableId).single();
      setTableState(t);
      const { data: p } = await supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number');
      setPlayersState(p);
    };
    fetchGame();

    // Listen for live pot/turn changes
    const gameSub = supabase.channel('game_updates')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'poker_tables', filter: `id=eq.${tableId}` }, (payload) => {
        setTableState(payload.new);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_players', filter: `table_id=eq.${tableId}` }, () => {
        // Refetch players to easily keep them in seat order
        supabase.from('table_players').select('*').eq('table_id', tableId).order('seat_number').then(({data}) => setPlayersState(data));
      })
      .subscribe();

    return () => supabase.removeChannel(gameSub);
  }, [tableId]);

  const joinQueue = async () => {
    if (!userId) return alert("Please log in first!");
    await supabase.from('queue').insert([{ player_id: userId }]);
    setInQueue(true);
    const { count } = await supabase.from('queue').select('*', { count: 'exact' });
    setQueueCount(count);
  };

  const handleFold = () => console.log("Fold");
  const handleCall = () => console.log("Call");
  const handleRaise = () => console.log("Raise");

  // === UI RENDERING ===
  if (tableId && tableState) {
    const myPlayer = playersState.find(p => p.player_id === userId);
    const opponents = playersState.filter(p => p.player_id !== userId);
    const isMyTurn = tableState.current_turn_player_id === userId;

    // Safe parsing in case Supabase returns JSON strings instead of arrays
    const parseJSON = (data) => typeof data === 'string' ? JSON.parse(data) : (data || []);
    const myHoleCards = myPlayer ? parseJSON(myPlayer.hole_cards) : [];
    const communityCards = parseJSON(tableState.community_cards);

    return (
      <div className="flex flex-col items-center justify-between min-h-screen bg-green-800 text-white py-12 px-4">
        
        {/* Opponents */}
        <div className="flex flex-wrap justify-center gap-8 mb-8">
          {opponents.map((opp, i) => (
            <div key={i} className={`bg-green-900 p-4 rounded-lg shadow-xl text-center border-2 ${tableState.current_turn_player_id === opp.player_id ? 'border-yellow-400' : 'border-green-700'}`}>
              <p className="text-sm text-neutral-400">Seat {opp.seat_number}</p>
              <p className="font-bold">Chips: {opp.chips}</p>
              {opp.current_bet > 0 && <p className="text-xs mt-1 text-yellow-400">Bet: {opp.current_bet}</p>}
              {opp.status === 'folded' && <p className="text-xs mt-1 text-red-400 font-bold">FOLDED</p>}
            </div>
          ))}
        </div>

        {/* The Board */}
        <div className="flex flex-col items-center mb-8">
          <div className="bg-green-900/50 px-8 py-4 rounded-full mb-6 border border-green-700">
            <h2 className="text-2xl font-bold text-yellow-400">Pot: {tableState.pot}</h2>
          </div>
          
          <div className="flex gap-2">
            {communityCards.length > 0 ? (
              communityCards.map((card, index) => (
                <div key={index} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded shadow-lg border-2 border-neutral-300">
                  {card}
                </div>
              ))
            ) : (
              <div className="text-neutral-400 italic">Preflop</div>
            )}
          </div>
        </div>

        {/* Player UI */}
        {myPlayer && (
          <div className={`w-full max-w-2xl bg-neutral-900 p-6 rounded-t-2xl shadow-2xl border-t-4 ${isMyTurn ? 'border-yellow-400' : 'border-neutral-700'}`}>
            <div className="flex justify-between items-end">
              
              <div>
                <p className="text-sm text-neutral-400 mb-2">My Stack: <span className="text-white font-bold">{myPlayer.chips}</span></p>
                <div className="flex gap-2">
                  {myHoleCards.map((card, index) => (
                    <div key={index} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded shadow-lg border-2 border-blue-500">
                      {card}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-end gap-3">
                {isMyTurn ? (
                  <div className="text-yellow-400 font-bold mb-1 animate-pulse">Your Turn!</div>
                ) : (
                  <div className="text-neutral-500 font-bold mb-1">Waiting for turn...</div>
                )}
                
                <div className="flex gap-3">
                  <button onClick={handleFold} disabled={!isMyTurn} className="bg-red-600 hover:bg-red-700 disabled:opacity-50 px-6 py-3 rounded font-bold transition-colors">
                    Fold
                  </button>
                  <button onClick={handleCall} disabled={!isMyTurn} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-6 py-3 rounded font-bold transition-colors">
                    Call
                  </button>
                  <div className="flex overflow-hidden rounded shadow-lg">
                    <button onClick={handleRaise} disabled={!isMyTurn} className="bg-yellow-500 hover:bg-yellow-600 text-black disabled:opacity-50 px-6 py-3 font-bold transition-colors">
                      Raise
                    </button>
                    <input type="number" defaultValue={tableState.highest_bet * 2} disabled={!isMyTurn} className="w-20 px-2 text-black outline-none border-l-2 border-yellow-600 disabled:opacity-50" />
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>
    );
  }

  // Lobby fallback
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white p-4">
      <div className="bg-neutral-800 p-8 rounded shadow-md w-full max-w-sm text-center">
        <h1 className="text-3xl font-bold mb-6">Texas Hold'em</h1>
        {!inQueue ? (
          <button onClick={joinQueue} className="w-full bg-blue-600 hover:bg-blue-700 py-3 rounded font-bold text-xl transition-colors">Play Now</button>
        ) : (
          <div>
            <div className="animate-pulse text-yellow-400 text-xl font-bold mb-4">Searching for table...</div>
            <p className="text-neutral-400 mb-2">Players in queue: {queueCount}</p>
          </div>
        )}
      </div>
    </div>
  );
}