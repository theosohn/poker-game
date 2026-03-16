import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white p-4">
      <h1 className="text-5xl font-bold mb-4">Texas Hold'em</h1>
      <p className="text-xl text-neutral-400 mb-8">No limit. Real-time multiplayer.</p>
      
      <Link 
        href="/login" 
        className="bg-blue-600 hover:bg-blue-700 py-3 px-8 rounded font-bold text-xl transition-colors"
      >
        Enter Game
      </Link>
    </div>
  );
}