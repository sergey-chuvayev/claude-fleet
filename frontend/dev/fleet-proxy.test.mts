import { describe, expect, it } from 'vitest'
import { fleetProxy, fleetTarget, forwardedHeaders, refuse } from './fleet-proxy.mts'

describe('dev proxy guard', () => {
  const target = fleetTarget(7777)

  it('lets the dev page through and refuses what Fleet would refuse', () => {
    expect(refuse({ host: '127.0.0.1:5173' }, 5173)).toBeNull()
    expect(refuse({ host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }, 5173)).toBeNull()
    expect(refuse({ host: 'evil.test:5173' }, 5173)).toBe('Invalid host.')
    expect(refuse({ host: '127.0.0.1:5173', origin: 'https://evil.test' }, 5173)).toBe('Cross-origin requests are not allowed.')
    expect(refuse({ host: '127.0.0.1:5173', origin: 'http://localhost:5173' }, 5173)).toBe('Cross-origin requests are not allowed.')
    expect(refuse({ host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }, 5173)).toBe('Cross-site requests are not allowed.')
  })

  it('rewrites Host always and Origin only when the browser sent one', () => {
    expect(forwardedHeaders({ host: '127.0.0.1:5173' }, target)).toEqual({ host: '127.0.0.1:7777' })
    expect(forwardedHeaders({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }, target)).toEqual({
      host: '127.0.0.1:7777',
      origin: 'http://127.0.0.1:7777',
    })
  })

  it('proxies every Fleet path, the event stream included', () => {
    expect(Object.keys(fleetProxy(target))).toEqual(['/api', '/theme.css', '/manifest.webmanifest'])
  })
})
