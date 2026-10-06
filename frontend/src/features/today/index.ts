// The Today feature's public surface. The shell mounts TodayPane and DayConsole from
// the view registry; the rest is for other features.
import { useCallback } from 'react'
import { useActions } from '../../app/AppStore'
import { requestReveal } from './useDay'

export { DayConsole } from './DayConsole'
export { ReportBack } from './ReportBack'
export { TodayPane } from './TodayPane'
export { groupBoardEvents } from './groupBoardEvents'
export { linkLabel } from './day'

/** Show one Day item on the board, opened and in view (a project's task, a notification). */
export function useShowDayItem(): (itemId: string) => void {
  const { navigate } = useActions()
  return useCallback(
    (itemId: string) => {
      navigate('today')
      requestReveal(itemId)
    },
    [navigate],
  )
}
