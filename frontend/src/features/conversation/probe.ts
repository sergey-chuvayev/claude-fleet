// A render counter for tests: MessageBlock reports its message id each time it
// renders. Nothing provides it in the app, so it costs one context read per block.
import { createContext, useContext } from 'react'

export const RenderProbe = createContext<((messageId: string) => void) | null>(null)

export function useRenderProbe(messageId: string): void {
  useContext(RenderProbe)?.(messageId)
}
