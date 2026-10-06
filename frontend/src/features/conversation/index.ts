// The conversation feature's public surface. The Sessions view mounts <Conversation>;
// the rest is exported for other feature panes that show message records.
export { Conversation, type ConversationProps, type ConversationTarget, conversationTarget } from './Conversation'
export { MessageBlock, type MessageBlockProps } from './MessageBlock'
export { MessageList, type MessageListProps } from './MessageList'
export { toolLabel } from './format'
