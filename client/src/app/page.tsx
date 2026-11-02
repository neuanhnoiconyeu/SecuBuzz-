'use client';

/**
 * Yahoo! Security Messenger - Demo Home Page
 * 
 * This page demonstrates:
 * - YahooChatWindow component
 * - E2EE crypto utilities
 * - Retro Windows XP UI with modern interactions
 */

import React, { useState, useCallback } from 'react';
import YahooChatWindow from '@/components/YahooChatWindow';

export default function Home() {
  const [lastBuzz, setLastBuzz] = useState<string>('');
  const [messageLog, setMessageLog] = useState<string[]>([]);

  const handleBuzz = useCallback(() => {
    setLastBuzz(`BUZZ triggered at ${new Date().toLocaleTimeString()}`);
  }, []);

  const handleSendMessage = useCallback((message: string) => {
    setMessageLog((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] Message sent: ${message}`,
    ]);
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Chat Window */}
      <YahooChatWindow
        contactName="SecureBot"
        onBuzz={handleBuzz}
        onSendMessage={handleSendMessage}
      />

      {/* Debug Panel (can be removed in production) */}
      <div className="fixed bottom-4 left-4 bg-black bg-opacity-80 text-green-400 text-xs p-3 rounded max-w-xs max-h-32 overflow-y-auto font-mono">
        <div className="font-bold mb-2">DEBUG LOG</div>
        {lastBuzz && <div className="text-yellow-300 mb-1">{lastBuzz}</div>}
        {messageLog.length > 0 && (
          <div>
            <div className="text-gray-400 mb-1">Recent messages:</div>
            {messageLog.slice(-3).map((log, idx) => (
              <div key={idx} className="text-xs">
                {log}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
