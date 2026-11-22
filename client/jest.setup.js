// jest.setup.js
import '@testing-library/jest-dom'
// Test-only: async Testing Library queries wait up to 5000 ms (default 1000 ms). Measured delayed rendering: the messengerAI "Review for draft" button appeared after 747-865 ms in isolation and missed the 1000 ms deadline under full-suite load. Approved by the Project_Owner (DB-5B, Linux C4 experiment).
import { configure } from '@testing-library/react'
configure({ asyncUtilTimeout: 5000 })

// Use Node's complete Web Crypto implementation when jsdom exposes only a partial one.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: require('crypto').webcrypto,
  })
}

if (!globalThis.TextEncoder || !globalThis.TextDecoder) {
  const { TextDecoder, TextEncoder } = require('util')
  globalThis.TextEncoder = globalThis.TextEncoder || TextEncoder
  globalThis.TextDecoder = globalThis.TextDecoder || TextDecoder
}

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return []
  }
  unobserve() {}
}

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
}

// Suppress console errors in tests (optional)
const originalError = console.error
beforeAll(() => {
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Warning: ReactDOM.render')
    ) {
      return
    }
    originalError.call(console, ...args)
  }
})

afterAll(() => {
  console.error = originalError
})
