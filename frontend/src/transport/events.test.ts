import { describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '../test/fakes'
import { EventStream, parseSessionsEvent } from './events'

describe('EventStream', () => {
  it('parses only string ids from a sessions event', () => {
    expect(parseSessionsEvent('["a",1,null,"projects"]')).toEqual(['a', 'projects'])
    expect(parseSessionsEvent('{}')).toBeNull()
    expect(parseSessionsEvent('nope')).toBeNull()
  })

  it('ignores events from a source it has replaced', () => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    const onList = vi.fn()
    const stream = new EventStream('/api/events', url => new FakeEventSource(url), {
      onSessions: () => {},
      onList,
      onOpen: () => {},
      onStatus: () => {},
    }, () => 0)
    stream.start()
    const first = FakeEventSource.instances[0]
    first?.fail(true)
    vi.advanceTimersByTime(500)
    expect(FakeEventSource.instances).toHaveLength(2)
    first?.emit('list', '{}')
    expect(onList).not.toHaveBeenCalled()
    FakeEventSource.instances[1]?.emit('list', '{}')
    expect(onList).toHaveBeenCalledTimes(1)
    stream.stop()
    expect(FakeEventSource.instances[1]?.closed).toBe(true)
    vi.useRealTimers()
  })
})
