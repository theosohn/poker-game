import { Hand } from 'pokersolver';
import { supabase } from './supabase';

export const handleShowdown = async (tableId, players, communityCards, pot) => {
  // 1. Calculate Side Pots based on hand_contribution
  let activePlayers = players.filter(p => p.status !== 'folded');
  
  // Sort players by how much they put into the pot (smallest to largest)
  let sortedActive = [...activePlayers].sort((a, b) => (a.hand_contribution || 0) - (b.hand_contribution || 0));
  let pots = [];
  let currentCap = 0;

  // Build the pots tier by tier
  for (let i = 0; i < sortedActive.length; i++) {
      let p = sortedActive[i];
      let cap = p.hand_contribution || 0;
      
      if (cap > currentCap) {
          let potSize = 0;
          let eligiblePlayers = [];
          
          for (let allP of players) {
             let pContrib = allP.hand_contribution || 0;
             // Take chips from everyone up to this tier's cap
             let contribToTier = Math.max(0, Math.min(pContrib, cap) - currentCap);
             potSize += contribToTier;
             
             // Only non-folded players who matched this tier can win it
             if (allP.status !== 'folded' && pContrib >= cap) {
                 eligiblePlayers.push(allP);
             }
          }
          pots.push({ size: potSize, eligiblePlayers: eligiblePlayers });
          currentCap = cap;
      }
  }

  // Any leftover chips from folded players go into the highest active pot
  let extraChips = 0;
  for (let allP of players) {
      let pContrib = allP.hand_contribution || 0;
      if (pContrib > currentCap) extraChips += (pContrib - currentCap);
  }
  if (extraChips > 0 && pots.length > 0) pots[pots.length - 1].size += extraChips;

  // 2. Evaluate winners for each pot (Largest pool of players -> Smallest)
  let results = [];
  let potIndex = 0;

  for (let p of pots) {
      if (p.size === 0) continue;

      let winners = [];
      let winningHandName = '';

      if (p.eligiblePlayers.length === 1) {
          winners = [p.eligiblePlayers[0]];
          winningHandName = 'Default (Opponents Folded)';
      } else {
          const solvedHands = p.eligiblePlayers.map(player => {
              const pCards = typeof player.hole_cards === 'string' ? JSON.parse(player.hole_cards) : player.hole_cards;
              const board = typeof communityCards === 'string' ? JSON.parse(communityCards) : communityCards;
              const hand = Hand.solve([...pCards, ...board]);
              return { ...player, solvedHand: hand };
          });
          const winningSolvedHands = Hand.winners(solvedHands.map(player => player.solvedHand));
          winners = solvedHands.filter(player => winningSolvedHands.includes(player.solvedHand));
          winningHandName = winners[0].solvedHand.name;
      }

      const splitAmount = Math.floor(p.size / winners.length);
      for (let w of winners) {
          let pIdx = players.findIndex(pl => pl.player_id === w.player_id);
          players[pIdx].chips += splitAmount;
      }

      results.push({
          isMainPot: potIndex === 0,
          potSize: p.size,
          winners: winners.map(w => w.player_id),
          winningHandName: winningHandName,
          amountPerWinner: splitAmount
      });
      potIndex++;
  }

  // 3. Save the results to the database so all clients animate it
  for (let p of players) {
      await supabase.from('table_players').update({ chips: p.chips }).eq('id', p.id);
  }
  await supabase.from('poker_tables').update({
      game_stage: 'showdown',
      pot: 0,
      showdown_results: JSON.stringify(results) // Save array to trigger frontend
  }).eq('id', tableId);
};