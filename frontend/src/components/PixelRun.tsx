// "Running now", in the avatars' pixel style (public/ui.js running()): a 3x3 matrix
// whose pixels light up in turn. It marks the step, the reply or the line that is live
// this second. Styles: .pixel-run in components.css.
export function PixelRun({ label = 'Running' }: { label?: string }) {
  return (
    <span className="pixel-run" role="img" aria-label={label}>
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}
