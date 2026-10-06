// The conversation's blocks, newest last, keyed by message id. Bounded to the most
// recent 200 messages as the legacy console is; no virtualization (plan section 4).
import { memo } from 'react'
import type { Message } from '../../transport/contracts'
import { MESSAGE_WINDOW } from './format'
import { MessageBlock } from './MessageBlock'

export interface MessageListProps {
  readonly messages: readonly Message[]
  /** The id of the reply being written now, if any. */
  readonly streamingId: string | null
  readonly agent: string
  readonly onNotice?: ((text: string) => void) | undefined
}

export const windowOf = (messages: readonly Message[]): readonly Message[] =>
  messages.length > MESSAGE_WINDOW ? messages.slice(-MESSAGE_WINDOW) : messages

export const MessageList = memo(function MessageList({ messages, streamingId, agent, onNotice }: MessageListProps) {
  return (
    <>
      {windowOf(messages).map(message => (
        <MessageBlock key={message.id} message={message} streaming={message.id === streamingId} agent={agent} onNotice={onNotice} />
      ))}
    </>
  )
})
