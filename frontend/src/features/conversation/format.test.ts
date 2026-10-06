import { describe, expect, it } from 'vitest'
import { agentLabel, copyText, duration, isWorking, languageFor, startsCollapsed, toolLabel } from './format'

describe('conversation formatting', () => {
  it('names tools as public/blocks.js does', () => {
    expect(toolLabel('Bash')).toBe('Bash')
    expect(toolLabel('ToolSearch')).toBe('Loading tools')
    expect(toolLabel('mcp__fleet__day')).toBe('Board')
    expect(toolLabel('mcp__linear-server__get_issue')).toBe('Linear · get issue')
    expect(toolLabel('mcp__github__create_pull_request')).toBe('GitHub · create pull request')
    expect(toolLabel('mcp__claude_ai_Notion__notion-fetch')).toBe('Notion · notion-fetch')
    expect(toolLabel(null)).toBe('Tool')
  })

  it('formats durations', () => {
    expect(duration(null)).toBeNull()
    expect(duration(12)).toBe('12ms')
    expect(duration(15000)).toBe('15.0s')
    expect(duration(125000)).toBe('2m 5s')
  })

  it('picks a language from a file name', () => {
    expect(languageFor('/a/b/checkout.ts')).toBe('typescript')
    expect(languageFor('Cargo.toml')).toBe('plaintext')
    expect(languageFor('README')).toBeNull()
    expect(languageFor(undefined)).toBeNull()
  })

  it('collapses only finished non-delegation tool calls', () => {
    expect(startsCollapsed({ id: 'a', role: 'tool', tool: 'Bash', status: 'done' })).toBe(true)
    expect(startsCollapsed({ id: 'a', role: 'tool', tool: 'Bash', status: 'running' })).toBe(false)
    expect(startsCollapsed({ id: 'a', role: 'tool', tool: 'Bash', status: 'error' })).toBe(false)
    expect(startsCollapsed({ id: 'a', role: 'tool', tool: 'Agent', status: 'done' })).toBe(false)
    expect(startsCollapsed({ id: 'a', role: 'assistant', text: 'x' })).toBe(false)
  })

  it('copies prose as text and a Bash call as its command and output', () => {
    expect(copyText({ id: 'a', role: 'assistant', text: 'Hi' })).toBe('Hi')
    expect(copyText({ id: 'b', role: 'tool', tool: 'Bash', target: 'ls', input: { command: 'ls' }, result: 'a' })).toBe('Bash · ls\nls\n\na')
  })

  it('knows the working states and the engine label', () => {
    expect(['starting', 'running', 'approval', 'stopping'].every(isWorking)).toBe(true)
    expect(isWorking('idle')).toBe(false)
    expect(agentLabel('codex')).toBe('CODEX')
    expect(agentLabel(undefined)).toBe('CLAUDE')
  })
})
