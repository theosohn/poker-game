import { Hand } from 'pokersolver';
import { supabase } from './supabase';

// Event Hooks you requested
const triggerHandPlayedEvent = (playerId, handName) => {
  console.log(`EVENT: Player ${playerId} reached showdown with hand: ${handName}`);
};

const triggerChipsWonEvent = (playerId, amount) => {
  console.log(`EVENT: Player ${playerId} won ${amount} chips!`);
};

export const handleShowdown = async (tableId, players, communityCards, pot) => {
  // 1. Filter out folded players
  const activePlayers = players.filter(p => p.status !== 'folded');
  
  let winners = [];
  let winningHandName = '';

  // 2. If everyone else folded, the last person standing wins automatically
  if (activePlayers.length === 1) {
    winners = [activePlayers[0]];
    winningHandName = 'Default (Opponent Folded)';
  } 
  // 3. Otherwise, use pokersolver to evaluate the hands at Showdown
  else {
    const solvedHands = activePlayers.map(p => {
      // pokersolver needs exactly 7 cards (2 hole + 5 community)
      const pCards = typeof p.hole_cards === 'string' ? JSON.parse(p.hole_cards) : p.hole_cards;
      const board = typeof communityCards === 'string' ? JSON.parse(communityCards) : communityCards;
      
      const hand = Hand.solve([...pCards, ...board]);
      return { ...p, solvedHand: hand };
    });

    // Find the absolute best hand(s) out of the group
    const winningSolvedHands = Hand.winners(solvedHands.map(p => p.solvedHand));
    winners = solvedHands.filter(p => winningSolvedHands.includes(p.solvedHand));
    winningHandName = winners[0].solvedHand.name; 
  }

  // 4. Split the pot among the winners (usually just 1 winner, but ties happen!)
  const splitPot = Math.floor(pot / winners.length);

  // 5. Update Database and Trigger Events
  for (let p of players) {
    const isWinner = winners.some(w => w.player_id === p.player_id);
    const isPlayed = p.status !== 'folded'; // They reached the end without folding

    // Give winner their chips
    if (isWinner) {
      await supabase.from('table_players').update({ chips: p.chips + splitPot }).eq('id', p.id);
      triggerChipsWonEvent(p.player_id, splitPot);
    }

    // Trigger Played/Unplayed events
    if (isPlayed && activePlayers.length > 1) {
      triggerHandPlayedEvent(p.player_id, p.solvedHand ? p.solvedHand.name : 'Unknown');
    }
  }

  // 6. Update the table to show the winner so the UI can display it
  await supabase.from('poker_tables').update({
    game_stage: 'showdown',
    pot: 0 // Pot is emptied out to the players
  }).eq('id', tableId);

  return { winners, winningHandName, amount: splitPot };
};