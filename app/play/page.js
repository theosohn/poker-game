'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase';
import { getShuffledDeck } from '../../utils/deck';

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);
  
  const [tableState, setTableState] = useState(null);
  const [playersState, setPlayersState] = useState([]);
  const [raiseAmount, setRaiseAmount] = useState(20);
  
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
      .insert([{ 
        status: 'active', player_count: playersToJoin.length, pot: 15, highest_bet: 10,
        game_stage: 'preflop', current_turn_player_id: firstTurnPlayerId, deck: deck.slice(playersToJoin.length * 2) 
      }])
      .select().single();

    if (error) return console.error(error);

    const playersToInsert = playersToJoin.map((p, index) => {
      const holeCards = [deck[index * 2], deck[index * 2 + 1]];
      let chips = 1000;
      let currentBet = 0;
      if (index === 0) { chips = 995; currentBet = 5; } 
      if (index === 1) { chips = 990; currentBet = 10; } 

      return {
        table_id: tableData.id, player_id: p.player_id, seat_number: index + 1,
        chips: chips, current_bet: currentBet, hole_cards: holeCards, status: 'active'
      };
    });

    await supabase.from('table_players').insert(playersToInsert);
    const playerIds = playersToJoin.map(p => p.player_id);
    await supabase.from('queue').delete().in('player_id', playerIds);
  };

  useEffect(() => {
    if (!userId) return;

    const tableSub = supabase.channel('table_inserts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'table_players' }, (payload) => {
        if (payload.new.player_id === userId) { setTableId(payload.new.table_id); setInQueue(false); }
      }).subscribe();

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
        } else {
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        }
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

  // === THE GAME ENGINE LOGIC ===
  const processAction = async (actionType, betAmount = 0) => {
    if (!tableState || !playersState.length) return;

    const me = playersState.find(p => p.player_id === userId);
    let myNewChips = me.chips;
    let myNewBet = me.current_bet;
    let myNewStatus = me.status;
    let newHighestBet = tableState.highest_bet;
    let newPot = tableState.pot;

    // 1. Process the math for the specific action
    if (actionType === 'fold') {
      myNewStatus = 'folded';
    } 
    else if (actionType === 'call') {
      const callAmount = newHighestBet - me.current_bet;
      myNewChips -= callAmount;
      myNewBet += callAmount;
      newPot += callAmount;
    } 
    else if (actionType === 'raise') {
      const totalToPutIn = betAmount - me.current_bet; // e.g. raising TO 20
      myNewChips -= totalToPutIn;
      myNewBet = betAmount;
      newHighestBet = betAmount;
      newPot += totalToPutIn;
    }

    // Update my player in DB instantly
    await supabase.from('table_players').update({ chips: myNewChips, current_bet: myNewBet, status: myNewStatus }).eq('id', me.id);

    // 2. Determine Next Turn & Round State
    // Create a simulated future array of players to check if the round is over
    const futurePlayers = playersState.map(p => p.player_id === userId ? { ...p, chips: myNewChips, current_bet: myNewBet, status: myNewStatus } : p);
    const activePlayers = futurePlayers.filter(p => p.status === 'active');
    
    // Check if everyone active has matched the highest bet
    const isRoundOver = activePlayers.every(p => p.current_bet === newHighestBet) && activePlayers.length > 1;
    
    //