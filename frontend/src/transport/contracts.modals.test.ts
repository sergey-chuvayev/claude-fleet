// Parsers for the search, connections, queue, service, gateway and update routes,
// checked against the captured fleet-mixed answers.
import { describe, expect, it } from 'vitest'
import getSearchJob from '../test/fixtures/fleet-mixed/get-search-job.json'
import getService from '../test/fixtures/fleet-mixed/get-service.json'
import getUpdate from '../test/fixtures/fleet-mixed/get-update.json'
import postGatewayRemove from '../test/fixtures/fleet-mixed/post-gateway-remove.json'
import postQueue from '../test/fixtures/fleet-mixed/post-queue-enable.json'
import postServiceDisable from '../test/fixtures/fleet-mixed/post-service-disable.json'
import postUpdate from '../test/fixtures/fleet-mixed/post-update.json'
import {
  parseApprovalModeResponse,
  parseConnections,
  parseGatewayResponse,
  parseQueueResponse,
  parseSearchJob,
  parseService,
  parseServiceChange,
  parseUpdate,
} from './contracts'
import { ContractError } from './errors'

describe('modal route contracts', () => {
  it('accepts the captured answers', () => {
    expect(parseSearchJob(getSearchJob.response.body).status).toBe('done')
    expect(parseQueueResponse(postQueue.response.body)).toMatchObject({ enabled: true, limit: 2 })
    expect(parseService(getService.response.body).supported).toBe(false)
    expect(parseServiceChange(postServiceDisable.response.body).restarting).toBe(false)
    expect(parseGatewayResponse(postGatewayRemove.response.body)).toEqual({ gateway: { configured: false, source: null }, testMessage: null })
    expect(parseUpdate(getUpdate.response.body).available).toBe(false)
    expect(parseUpdate(postUpdate.response.body).state).toBe('installed')
    expect(parseApprovalModeResponse({ defaultApprovalMode: 'auto' })).toBe('auto')
  })

  it('rejects answers that do not have the shape the page relies on', () => {
    expect(() => parseSearchJob({ job: { id: 'x', question: 'q', status: 'weird', hits: [] } })).toThrow(ContractError)
    expect(() => parseSearchJob({})).toThrow(ContractError)
    expect(() => parseQueueResponse({ queue: { enabled: 'yes' } })).toThrow(ContractError)
    expect(() => parseApprovalModeResponse({ defaultApprovalMode: 'sometimes' })).toThrow(ContractError)
    expect(() => parseUpdate({ update: { available: 'maybe' } })).toThrow(ContractError)
  })

  it('drops everything private from a connection row before it can reach the page', () => {
    const parsed = parseConnections({
      connections: {
        cwd: '/p',
        source: 'project',
        connectionId: 'c1',
        checkedAt: 1,
        servers: [
          {
            name: 'docs',
            status: 'connected',
            tools: ['a'],
            config: { env: { TOKEN: 'secret' } },
            env: { TOKEN: 'secret' },
            command: '/bin/secret',
            args: ['--key', 'secret'],
            headers: { Authorization: 'Bearer secret' },
          },
        ],
      },
    })
    expect(JSON.stringify(parsed)).not.toContain('secret')
    expect(Object.keys(parsed.servers[0]!).sort()).toEqual(['name', 'status', 'tools'])
  })
})
