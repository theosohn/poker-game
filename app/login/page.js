'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation'; // <-- We added this
import { supabase } from '../../utils/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  
  const router = useRouter(); // <-- We initialize the router here

  const handleSignUp = async () => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setMessage(`Error: ${error.message}`);
    } else {
      setMessage('Success! Redirecting to the lobby...');
      // Automatically redirect to the play page
      router.push('/play'); 
    }
  };

  const handleLogin = async () => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(`Error: ${error.message}`);
    } else {
      setMessage('Successfully logged in! Redirecting...');
      // Automatically redirect to the play page
      router.push('/play'); 
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-white p-4">
      <div className="bg-neutral-800 p-8 rounded shadow-md w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-6 text-center">Poker Login</h1>
        
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 mb-4 text-black rounded outline-none"
        />
        
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 mb-6 text-black rounded outline-none"
        />
        
        <div className="flex justify-between gap-4">
          <button 
            onClick={handleLogin}
            className="w-full bg-blue-600 hover:bg-blue-700 py-2 rounded font-bold transition-colors"
          >
            Log In
          </button>
          
          <button 
            onClick={handleSignUp}
            className="w-full bg-green-600 hover:bg-green-700 py-2 rounded font-bold transition-colors"
          >
            Sign Up
          </button>
        </div>

        {message && <p className="mt-4 text-center text-sm text-yellow-400">{message}</p>}
      </div>
    </div>
  );
}