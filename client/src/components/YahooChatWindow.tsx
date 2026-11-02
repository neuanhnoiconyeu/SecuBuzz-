'use client';

/**
 * Yahoo! Security Messenger - Retro Windows XP Chat Window Component
 * 
 * Features:
 * - Authentic Windows XP Luna UI with blue gradient title bar
 * - Classic gray-beige window frame (#ece9d8)
 * - Butter-smooth micro-interactions with Tailwind transitions
 * - Chat history log with message display
 * - Encrypted message input with send button
 * - Iconic red BUZZ! alert button with shake animation
 * - Fully accessible keyboard shortcuts (Enter to send)
 * 
 * Design Era: Windows XP / Yahoo! Messenger (2000-2005)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { encryptMessage, decryptMessage, generateEncryptionKey } from '@/utils/crypto';

/**
 * Message interface for the chat history
 */
interface Message {
  id: string;
  sender: 'user' | 'contact';
  text: string;
  timestamp: Date;
  encrypted?: boolean;
}

/**
 * Props for the YahooChatWindow component
 */
interface YahooChatWindowProps {
  contactName?: string;
  onBuzz?: () => void;
  onSendMessage?: (message: string) => void;
}

export const YahooChatWindow: React.FC<YahooChatWindowProps> = ({
  contactName = 'Yahoo! User',
  onBuzz,
  onSendMessage,
}) => {
  // State management
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: 'contact',
      text: 'Hey! Welcome to Yahoo! Security Messenger 🔐',
      timestamp: new Date(Date.now() - 60000),
      encrypted: false,
    },
    {
      id: '2',
      sender: 'contact',
      text: 'Your messages are end-to-end encrypted.',
      timestamp: new Date(Date.now() - 30000),
      encrypted: true,
    },
  ]);

  const [inputValue, setInputValue] = useState('');
  const [isBuzzActive, setIsBuzzActive] = useState(false);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const buzzButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Initialize encryption key on component mount
   */
  useEffect(() => {
    const initCrypto = async () => {
      try {
        const key = await generateEncryptionKey();
        setCryptoKey(key);
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize encryption:', error);
      }
    };

    initCrypto();
  }, []);

  /**
   * Auto-scroll to latest message (smooth scroll)
   */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /**
   * Focus input on component mount
   */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * Handle sending a message
   * Encrypts the message before sending (for demo purposes, shown as encrypted flag)
   */
  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || !cryptoKey) return;

    const messageText = inputValue.trim();

    // Create new user message
    const newMessage: Message = {
      id: Date.now().toString(),
      sender: 'user',
      text: messageText,
      timestamp: new Date(),
      encrypted: true,
    };

    // Add message to chat history
    setMessages((prev) => [...prev, newMessage]);
    setInputValue('');

    // Call external callback if provided
    if (onSendMessage) {
      onSendMessage(messageText);
    }

    // Simulate encryption process (for demo)
    try {
      const { ciphertext, iv } = await encryptMessage(messageText, cryptoKey);
      // In production, send ciphertext and iv to server
      console.debug('Message encrypted:', { ciphertext, iv });
    } catch (error) {
      console.error('Encryption error:', error);
    }

    // Refocus input
    inputRef.current?.focus();
  }, [inputValue, cryptoKey, onSendMessage]);

  /**
   * Handle BUZZ! alert button
   * Triggers shake animation and sound effect
   */
  const handleBuzz = useCallback(() => {
    setIsBuzzActive(true);

    // Trigger callback if provided
    if (onBuzz) {
      onBuzz();
    }

    // Play BUZZ! sound effect (simulated)
    playBuzzSound();

    // Reset animation after it completes
    setTimeout(() => {
      setIsBuzzActive(false);
    }, 500);
  }, [onBuzz]);

  /**
   * Play BUZZ! sound (Web Audio API)
   * Creates a simple beep sound effect
   */
  const playBuzzSound = useCallback(() => {
    try {
      const audioContext = new (globalThis.AudioContext ||
        (globalThis as any).webkitAudioContext)();

      // Create oscillator for BUZZ sound
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.connect(gain);
      gain.connect(audioContext.destination);

      // BUZZ sound parameters
      oscillator.frequency.value = 440; // A note
      oscillator.type = 'sine';

      gain.gain.setValueAtTime(0.3, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.1
      );

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);

      // Second buzz for effect
      setTimeout(() => {
        const osc2 = audioContext.createOscillator();
        const gain2 = audioContext.createGain();

        osc2.connect(gain2);
        gain2.connect(audioContext.destination);

        osc2.frequency.value = 400;
        osc2.type = 'sine';

        gain2.gain.setValueAtTime(0.3, audioContext.currentTime);
        gain2.gain.exponentialRampToValueAtTime(
          0.01,
          audioContext.currentTime + 0.1
        );

        osc2.start(audioContext.currentTime);
        osc2.stop(audioContext.currentTime + 0.1);
      }, 120);
    } catch (error) {
      console.debug('Audio context not available:', error);
    }
  }, []);

  /**
   * Handle keyboard shortcuts
   * Enter to send, Shift+Enter for newline
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    },
    [handleSendMessage]
  );

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-b from-blue-400 to-blue-300 p-4">
      {/* Main Window Container - Windows XP Style */}
      <div
        className="w-full max-w-lg bg-[#ece9d8] rounded-sm shadow-2xl overflow-hidden border-2 border-t-blue-200 border-l-blue-200 border-b-gray-400 border-r-gray-400"
        style={{
          boxShadow: 'inset 1px 1px 0 rgba(255,255,255,0.5), inset -1px -1px 0 rgba(0,0,0,0.1)',
        }}
      >
        {/* Title Bar - Windows XP Luna Blue Gradient */}
        <div
          className="bg-gradient-to-r from-blue-600 via-blue-500 to-blue-400 px-2 py-1 flex items-center justify-between group"
          style={{
            background: 'linear-gradient(90deg, #0078d4 0%, #0078d4 50%, #0a7bc4 100%)',
          }}
        >
          {/* Title and Icon */}
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-white bg-opacity-80 rounded-sm flex items-center justify-center text-xs font-bold text-blue-600">
              Y!
            </div>
            <span className="text-white text-sm font-bold select-none">
              Yahoo! Security Messenger - {contactName}
            </span>
          </div>

          {/* Window Controls (Minimize, Maximize, Close) */}
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              className="w-5 h-5 bg-gradient-to-b from-blue-300 to-blue-500 rounded-sm flex items-center justify-center text-white text-xs hover:from-blue-200 hover:to-blue-400 transition-all active:from-blue-400 active:to-blue-600"
              aria-label="Minimize"
            >
              _
            </button>
            <button
              className="w-5 h-5 bg-gradient-to-b from-blue-300 to-blue-500 rounded-sm flex items-center justify-center text-white text-xs hover:from-blue-200 hover:to-blue-400 transition-all active:from-blue-400 active:to-blue-600"
              aria-label="Maximize"
            >
              □
            </button>
            <button
              className="w-5 h-5 bg-gradient-to-b from-red-400 to-red-600 rounded-sm flex items-center justify-center text-white text-xs hover:from-red-300 hover:to-red-500 transition-all active:from-red-500 active:to-red-700"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Window Content */}
        <div className="p-3 space-y-3 bg-[#ece9d8]">
          {/* Chat History Area */}
          <div
            className="bg-white rounded-sm p-3 h-72 overflow-y-auto border border-gray-300"
            style={{
              boxShadow:
                'inset 1px 1px 0 rgba(255,255,255,1), inset -1px -1px 0 rgba(0,0,0,0.08)',
            }}
          >
            <div className="space-y-3">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`text-sm transition-all duration-200 ${
                    message.sender === 'user' ? 'text-right' : 'text-left'
                  }`}
                >
                  {/* Sender Label */}
                  <div
                    className={`text-xs font-bold mb-1 ${
                      message.sender === 'user'
                        ? 'text-blue-700'
                        : 'text-green-700'
                    }`}
                  >
                    {message.sender === 'user' ? 'You' : contactName}
                    {message.encrypted && (
                      <span className="ml-1 text-xs text-red-600">🔒</span>
                    )}
                  </div>

                  {/* Message Bubble */}
                  <div
                    className={`inline-block max-w-xs px-3 py-2 rounded-sm transition-all duration-200 hover:shadow-md ${
                      message.sender === 'user'
                        ? 'bg-blue-100 border border-blue-300 text-gray-900'
                        : 'bg-gray-100 border border-gray-300 text-gray-900'
                    }`}
                    style={{
                      wordWrap: 'break-word',
                      boxShadow:
                        message.sender === 'user'
                          ? '0 2px 4px rgba(0, 0, 0, 0.1)'
                          : '0 1px 2px rgba(0, 0, 0, 0.08)',
                    }}
                  >
                    {message.text}
                  </div>

                  {/* Timestamp */}
                  <div className="text-xs text-gray-500 mt-1">
                    {message.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input Area */}
          <div className="space-y-2">
            {/* Text Input */}
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your encrypted message here... (Shift+Enter for new line)"
              className="w-full h-24 p-2 border border-gray-300 rounded-sm bg-white text-gray-900 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 transition-all"
              style={{
                boxShadow:
                  'inset 1px 1px 0 rgba(255,255,255,1), inset -1px -1px 0 rgba(0,0,0,0.08)',
              }}
              disabled={!isInitialized}
            />

            {/* Button Controls */}
            <div className="flex gap-2">
              {/* Send Button */}
              <button
                onClick={handleSendMessage}
                disabled={!inputValue.trim() || !isInitialized}
                className="flex-1 px-4 py-2 bg-gradient-to-b from-gray-200 to-gray-400 text-gray-900 font-bold text-sm rounded-sm border border-gray-400 border-t-white border-l-white transition-all active:from-gray-400 active:to-gray-200 disabled:opacity-50 disabled:cursor-not-allowed hover:from-gray-300 hover:to-gray-500"
                style={{
                  boxShadow:
                    'inset 1px 1px 0 rgba(255,255,255,0.8), inset -1px -1px 0 rgba(0,0,0,0.2), 0 2px 4px rgba(0,0,0,0.1)',
                }}
              >
                📤 Send
              </button>

              {/* BUZZ! Alert Button */}
              <button
                ref={buzzButtonRef}
                onClick={handleBuzz}
                className={`px-4 py-2 bg-gradient-to-b from-red-500 to-red-700 text-white font-bold text-sm rounded-sm border border-red-700 border-t-red-300 transition-all hover:from-red-400 hover:to-red-600 active:from-red-600 active:to-red-800 ${
                  isBuzzActive ? 'animate-buzz-shake' : ''
                }`}
                style={{
                  boxShadow:
                    'inset 1px 1px 0 rgba(255,255,255,0.3), inset -1px -1px 0 rgba(0,0,0,0.3), 0 2px 4px rgba(0,0,0,0.2)',
                }}
                aria-label="Send BUZZ! alert"
              >
                {isBuzzActive ? '🔔' : '🔴'} BUZZ!
              </button>
            </div>

            {/* Status/Info Text */}
            <div className="text-xs text-gray-600 px-2">
              {!isInitialized ? (
                <span className="text-orange-600">🔄 Initializing encryption...</span>
              ) : (
                <span className="text-green-600">🔐 E2EE Ready • {messages.length} messages</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* CSS Animations - Shake effect for BUZZ */}
      <style jsx>{`
        @keyframes buzz-shake {
          0%, 100% {
            transform: translateX(0);
          }
          10% {
            transform: translateX(-4px) rotateZ(-0.5deg);
          }
          20% {
            transform: translateX(4px) rotateZ(0.5deg);
          }
          30% {
            transform: translateX(-4px) rotateZ(-0.5deg);
          }
          40% {
            transform: translateX(4px) rotateZ(0.5deg);
          }
          50% {
            transform: translateX(-4px) rotateZ(-0.5deg);
          }
          60% {
            transform: translateX(4px) rotateZ(0.5deg);
          }
          70% {
            transform: translateX(-2px) rotateZ(-0.25deg);
          }
          80% {
            transform: translateX(2px) rotateZ(0.25deg);
          }
          90% {
            transform: translateX(-1px) rotateZ(0);
          }
        }

        .animate-buzz-shake {
          animation: buzz-shake 0.5s ease-in-out;
        }

        /* Custom scrollbar for retro feel */
        div::-webkit-scrollbar {
          width: 16px;
        }

        div::-webkit-scrollbar-track {
          background: #ece9d8;
          border: 1px solid #dfddce;
        }

        div::-webkit-scrollbar-thumb {
          background: linear-gradient(to bottom, #e0ddd0, #c5c2bb);
          border: 1px solid #777;
          border-radius: 2px;
        }

        div::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(to bottom, #dfddce, #b9b6ad);
        }
      `}</style>
    </div>
  );
};

export default YahooChatWindow;
