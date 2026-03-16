import { useState } from 'react';

export default function PokerTable() {
  const [chips, setChips] = useState(1000); // Everyone starts with 1000
  const [pot, setPot] = useState(0);
  const [holeCards, setHoleCards] = useState(['Ah', 'Kd']); // Ace of Hearts, King of Diamonds
  const [raiseAmount, setRaiseAmount] = useState(10);

  // Future Event Hooks
  const triggerHandPlayedEvent = () => console.log("Event: Hand Reached Showdown!");
  const triggerChipsWonEvent = (amount) => console.log(`Event: Won ${amount} chips!`);

  const handleFold = () => {
    // Logic to end turn and log stats
  };

  const handleCall = () => {
    // Logic to subtract chips, add to pot
  };

  const handleRaise = () => {
    setChips(chips - raiseAmount);
    setPot(pot + raiseAmount);
    // Logic to set current bet
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-green-800 text-white">
      <div className="text-2xl mb-4">Pot: {pot}</div>
      
      {/* Barebones Cards */}
      <div className="flex gap-2 mb-8">
        {holeCards.map(card => (
          <div key={card} className="bg-white text-black p-4 text-xl font-bold rounded shadow">
            {card}
          </div>
        ))}
      </div>

      <div className="text-xl mb-4">Your Chips: {chips}</div>

      {/* Action Buttons */}
      <div className="flex gap-4 items-center">
        <button onClick={handleFold} className="bg-red-500 px-4 py-2 rounded">Fold</button>
        <button onClick={handleCall} className="bg-blue-500 px-4 py-2 rounded">Call</button>
        <div className="flex bg-yellow-500 rounded overflow-hidden">
          <button onClick={handleRaise} className="px-4 py-2 font-bold text-black">Raise</button>
          <input 
            type="number" 
            className="w-20 px-2 text-black outline-none" 
            value={raiseAmount}
            onChange={(e) => setRaiseAmount(Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}