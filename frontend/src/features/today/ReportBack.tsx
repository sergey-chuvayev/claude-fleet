// An agent launched from Today reported back (F32): say so once, with a toast, the
// soft "report" tone and, when switched on, a macOS notification whose click brings
// Fleet forward on that item. The first snapshot only sets the mark, so opening Fleet
// does not replay old reports. Renders nothing. Mounted once by the shell
// (app/background.tsx), beside the SoundController, so a report is announced on
// every view.
import { useEffect, useRef } from 'react'
import { useActions } from '../../app/AppStore'
import { useOptionalToast } from '../../components/Toast'
import { notifyEnabled } from '../settings/notifications'
import { sounds } from '../sounds/sounds'
import { requestReveal, useTodayRows } from './useDay'

interface Report {
  readonly itemId: string
  readonly title: string
  readonly question: string
  readonly at: number
}

function reportOf(row: unknown): Report | null {
  const progress = (row as { dayProgress?: { report?: unknown } } | null)?.dayProgress
  const report = progress?.report as Partial<Report> | null | undefined
  if (!report || typeof report.at !== 'number' || typeof report.itemId !== 'string') return null
  return { itemId: report.itemId, title: String(report.title ?? ''), question: String(report.question ?? ''), at: report.at }
}

export function ReportBack({ play = sounds.play, notify = notifyEnabled }: { play?: (name: 'report') => unknown; notify?: () => boolean }) {
  const today = useTodayRows()
  const toast = useOptionalToast()
  const { navigate } = useActions()
  const seen = useRef<number | null>(null)
  const { loaded, day } = today

  useEffect(() => {
    if (!loaded) return
    const report = reportOf(day)
    if (seen.current === null) {
      seen.current = report?.at ?? 0
      return
    }
    if (!report || report.at <= seen.current) return
    seen.current = report.at
    toast?.(`${report.title}: ${report.question}`.slice(0, 220))
    play('report')
    if (!notify()) return
    try {
      const note = new Notification(report.title, { body: report.question.slice(0, 300), tag: `fleet-report-${report.itemId}` })
      note.onclick = () => {
        window.focus()
        navigate('today')
        requestReveal(report.itemId)
        note.close()
      }
    } catch {
      // A browser that refuses to construct one (no permission after all) stays quiet.
    }
  }, [loaded, day, toast, play, notify, navigate])

  return null
}
