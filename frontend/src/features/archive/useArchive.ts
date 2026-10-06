// Archive writes (F24). Putting a session away hides its row and nothing else: the
// transcript stays on disk, `claude --resume` still reaches it and Search still finds
// it. Managed sessions are closed, never archived, so only transcript ids go here.
import { useCallback } from 'react'
import { useToast } from '../../components/Toast'
import { type ArchiveRule, parseArchiveResult, parseArchiveRuleResult } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { keys } from '../../transport/resources'

const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`

export function useArchive() {
  const client = useFleetClient()
  const toast = useToast()

  /** Archive or restore these transcripts. Resolves true when the server took it. */
  const setArchived = useCallback(
    async (ids: readonly string[], archived: boolean): Promise<boolean> => {
      if (!ids.length) return false
      try {
        parseArchiveResult(await client.post('/api/archive', { ids, archived }, { invalidate: [keys.sessions] }))
        toast(`${plural(ids.length)} ${archived ? 'archived' : 'restored'}`)
        return true
      } catch (error) {
        toast(error instanceof Error && error.message ? error.message : 'Could not update the archive.')
        return false
      }
    },
    [client, toast],
  )

  /** Save the standing rule; the sweep and the rule share one age threshold. */
  const setRule = useCallback(
    async (rule: ArchiveRule): Promise<boolean> => {
      try {
        parseArchiveRuleResult(await client.post('/api/archive/rule', { enabled: rule.enabled, days: rule.days }, { invalidate: [keys.sessions] }))
        return true
      } catch (error) {
        toast(error instanceof Error && error.message ? error.message : 'Could not save the archive rule.')
        return false
      }
    },
    [client, toast],
  )

  return { setArchived, setRule }
}
