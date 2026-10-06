// Placeholder (shell slot): the Day board. Replace this file with the Today feature;
// the shell renders it inside section#today-pane.sessions-pane.today-pane.
import { EmptyState } from '../../components/EmptyState'

export function TodayPane() {
  return <EmptyState className="today-empty" title="Good morning." text="Your Day board will appear here." />
}
