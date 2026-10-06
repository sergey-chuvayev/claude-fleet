// Placeholder (shell slot): the Day's console beside the board, in aside#detail.
// Replace this file with the Today feature. useSelection('today') is the selected
// item thread (a 'day-thread' selection), or null for the Day itself.
export function DayConsole() {
  return (
    <div className="console-empty">
      <strong>Your Day agent</strong>
      <span>Its conversation appears here once you start your day.</span>
    </div>
  )
}
