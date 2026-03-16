'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase';

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);
  
  // We use a ref for the timer so it doesn't accidentally restart 
  const timerRef = useRef(null);

  // 1. Get user and check if they are already sitting at a table
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

  // 2. The Matchmaker Engine
  const startMatch = async (playersToJoin) => {
    // A. Create the poker table
    const { data: tableData, error } = await supabase
      .from('poker_tables')
      .insert([{ status: 'active', player_count: playersToJoin.length }])
      .select()
      .single();

    if (error) return console.error(error);

    // B. Give players their chips and seat numbers
    const playersToInsert = playersToJoin.map((p, index) => ({
      table_id: tableData.id,
      player_id: p.player_id,
      seat_number: index + 1,
      chips: 1000
    }));

    await supabase.from('table_players').insert(playersToInsert);

    // C. Remove them from the queue
    const playerIds = playersToJoin.map(p => p.player_id);
    await supabase.from('queue').delete().in('player_id', playerIds);
  };

  // 3. Listen for Queue and Table Updates
  useEffect(() => {
    if (!userId) return;

    // Listen for when we get pulled into a table
    const tableSub = supabase
      .channel('table_inserts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'table_players' }, (payload) => {
        if (payload.new.player_id === userId) {
          setTableId(payload.new.table_id);
          setInQueue(false);
        }
      })
      .subscribe();

    // Listen to the queue to trigger the matchmaking rules
    const queueSub = supabase
      .channel('queue_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, async () => {
        const { data: currentQueue } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
        if (!currentQueue) return;
        
        setQueueCount(currentQueue.length);

        // RULE 1: 5 players = instant start
        if (currentQueue.length >= 5) {
          if (timerRef.current) clearTimeout(timerRef.current);
          
          // The 5th person to join runs the setup so it only happens once
          if (currentQueue[currentQueue.length - 1].player_id === userId) {
            startMatch(currentQueue.slice(0, 5));
          }
        } 
        // RULE 2: 2 to 4 players = 30-second timer
        else if (currentQueue.length >= 2) {
          // The 1st person in queue acts as the "Host" to run the timer
          if (currentQueue[0].player_id === userId && !timerRef.current) {
            timerRef.current = setTimeout(async () => {
              const { data: finalQueue } = await supabase.from('queue').select('*').order('joined_at', { ascending: true });
              startMatch(finalQueue);
            }, 30000); // 30,000 milliseconds = 30 seconds
          }
        } 
        // RULE 3: Less than 2 players = cancel any running timers
        else {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(tableSub);
      supabase.removeChannel(queueSub);
    };
  }, [userId]);

  const joinQueue = async () => {
    if (!userId) return alert("Please log in first!");
    
    const { error } = await supabase.from('queue').insert([{ player_id: userId }]);
    if (error) return console.error("Failed to join queue:", error);
    
    setInQueue(true);
    const { count } = await supabase.from('queue').select('*', { count: 'exact' });
    setQueueCount(count);
  };

  const handleFold = () => { console.log("Fold clicked"); /* Logic coming next */ };
  const handleCall = () => { console.log("Call clicked"); /* Logic coming next */ };
  const handleRaise = () => { console.log("Raise clicked"); /* Logic coming next */ };

  // If assigned a table, show the Game Room
  if (tableId) {
    // Hardcoded dummy data for the visual MVP (we will connect this to Supabase next)
    const dummyPot = 150;
    const dummyCommunityCards = ['As', 'Kd', 'Tc']; // Ace of Spades, King of Diamonds, Ten of Clubs
    const myHoleCards = ['Ah', 'Ah']; // Pocket Aces!
    const myChips = 1000;
    const isMyTurn = true; // Pretend it's your turn

    return (
      <div className="flex flex-col items-center justify-between min-h-screen bg-green-800 text-white py-12 px-4">
        
        {/* Top: Opponents (Simplified) */}
        <div className="flex gap-8 mb-8">
          <div className="bg-green-900 p-4 rounded-lg shadow-xl text-center border-2 border-green-700">
            <p className="text-sm text-neutral-400">Opponent 1</p>
            <p className="font-bold">Chips: 950</p>
            <p className="text-xs mt-1 text-yellow-400">Bet: 10</p>
          </div>
        </div>

        {/* Middle: The Board */}
        <div className="flex flex-col items-center mb-8">
          <div className="bg-green-900/50 px-8 py-4 rounded-full mb-6 border border-green-700">
            <h2 className="text-2xl font-bold text-yellow-400">Pot: {dummyPot}</h2>
          </div>
          
          <div className="flex gap-2">
            {dummyCommunityCards.length > 0 ? (
              dummyCommunityCards.map((card, index) => (
                <div key={index} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded shadow-lg border-2 border-neutral-300">
                  {card}
                </div>
              ))
            ) : (
              <div className="text-neutral-400 italic">Preflop - No community cards yet</div>
            )}
          </div>
        </div>

        {/* Bottom: Player UI */}
        <div className="w-full max-w-2xl bg-neutral-900 p-6 rounded-t-2xl shadow-2xl border-t-4 border-neutral-700">
          <div className="flex justify-between items-end">
            
            {/* My Cards & Stats */}
            <div>
              <p className="text-sm text-neutral-400 mb-2">My Stack: <span className="text-white font-bold">{myChips}</span></p>
              <div className="flex gap-2">
                {myHoleCards.map((card, index) => (
                  <div key={index} className="bg-white text-black w-16 h-24 flex items-center justify-center text-2xl font-bold rounded shadow-lg border-2 border-blue-500">
                    {card}
                  </div>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col items-end gap-3">
              {isMyTurn ? (
                <div className="text-yellow-400 font-bold mb-1 animate-pulse">Your Turn!</div>
              ) : (
                <div className="text-neutral-500 font-bold mb-1">Waiting for opponent...</div>
              )}
              
              <div className="flex gap-3">
                <button 
                  onClick={handleFold}
                  disabled={!isMyTurn}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 rounded font-bold transition-colors"
                >
                  Fold
                </button>
                <button 
                  onClick={handleCall}
                  disabled={!isMyTurn}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 rounded font-bold transition-colors"
                >
                  Call
                </button>
                <div className="flex overflow-hidden rounded shadow-lg">
                  <button 
                    onClick={handleRaise}
                    disabled={!isMyTurn}
                    className="bg-yellow-500 hover:bg-yellow-600 text-black disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 font-bold transition-colors"
                  >
                    Raise
                  </button>
                  <input 
                    type="number" 
                    defaultValue={20}
                    disabled={!isMyTurn}
                    className="w-20 px-2 text-black outline-none border-l-2 border-yellow-600 disabled:opacity-50" 
                  />
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // Otherwise, show the Lobby
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white p-4">
      <div className="bg-neutral-800 p-8 rounded shadow-md w-full max-w-sm text-center">
        <h1 className="text-3xl font-bold mb-6">Texas Hold'em</h1>
        
        {!inQueue ? (
          <button onClick={joinQueue} className="w-full bg-blue-600 hover:bg-blue-700 py-3 rounded font-bold text-xl transition-colors">
            Play Now
          </button>
        ) : (
          <div>
            <div className="animate-pulse text-yellow-400 text-xl font-bold mb-4">Searching for table...</div>
            <p className="text-neutral-400 mb-2">Players in queue: {queueCount}</p>
            {queueCount >= 2 && queueCount < 5 && (
              <p className="text-sm mt-4 text-green-400 font-bold">Minimum reached! Game starting in 30 seconds...</p>
            )}
            {queueCount < 2 && (
              <p className="text-sm mt-4 text-neutral-500">Waiting for at least 2 players to start...</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}