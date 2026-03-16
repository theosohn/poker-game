'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../utils/supabase';

export default function PlayPage() {
  const [inQueue, setInQueue] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [tableId, setTableId] = useState(null);
  const [userId, setUserId] = useState(null);

  // 1. Get the logged-in user when the page loads
  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) setUserId(user.id);
    };
    getUser();
  }, []);

  // 2. Listen for live updates to the queue
  useEffect(() => {
    if (!inQueue) return;

    // Subscribe to changes in the 'queue' table
    const queueSubscription = supabase
      .channel('queue_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, async () => {
        // Whenever the queue changes, count how many people are in it
        const { count } = await supabase.from('queue').select('*', { count: 'exact' });
        setQueueCount(count);

        // TODO: Add the 30-second timer and 5-player auto-start logic here later
      })
      .subscribe();

    return () => {
      supabase.removeChannel(queueSubscription);
    };
  }, [inQueue]);

  const joinQueue = async () => {
    if (!userId) return alert("Please log in first!");
    
    // 1. Try to insert the user, and catch any errors
    const { error } = await supabase.from('queue').insert([{ player_id: userId }]);
    
    if (error) {
      console.error("Failed to join queue:", error);
      alert("Database blocked the request! Check your console.");
      return; // Stop the function if it fails
    }
    
    setInQueue(true);

    // 2. Fetch the initial count immediately so it doesn't say 0
    const { count, error: countError } = await supabase.from('queue').select('*', { count: 'exact' });
    if (!countError) {
      setQueueCount(count);
    }
  };

  // If the player has been assigned a table, show the Poker Table
  if (tableId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-800 text-white">
        <h1 className="text-2xl mb-4">Table ID: {tableId}</h1>
        {/* We will build out the actual live table UI here in Step 2 */}
        <p>Game is starting...</p>
      </div>
    );
  }

  // Otherwise, show the Lobby / Queue screen
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white p-4">
      <div className="bg-neutral-800 p-8 rounded shadow-md w-full max-w-sm text-center">
        <h1 className="text-3xl font-bold mb-6">Texas Hold'em</h1>
        
        {!inQueue ? (
          <button 
            onClick={joinQueue}
            className="w-full bg-blue-600 hover:bg-blue-700 py-3 rounded font-bold text-xl"
          >
            Play Now
          </button>
        ) : (
          <div>
            <div className="animate-pulse text-yellow-400 text-xl font-bold mb-4">
              Searching for table...
            </div>
            <p className="text-neutral-400">Players in queue: {queueCount}</p>
            <p className="text-sm mt-4 text-neutral-500">Waiting for at least 2 players to start...</p>
          </div>
        )}
      </div>
    </div>
  );
}