export function getShuffledDeck() {
  const suits = ['h', 'd', 'c', 's']; // hearts, diamonds, clubs, spades
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  
  let deck = [];
  for (let s of suits) {
    for (let v of values) {
      deck.push(v + s);
    }
  }
  
  // Fisher-Yates Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  
  return deck;
}