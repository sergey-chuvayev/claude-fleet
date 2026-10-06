// The composer's public surface. <Composer> sends to /api/managed/:id/messages. The
// draft store and the image helpers are reusable by a composer that posts to another
// route (a project's ask box), under its own draft key; <TextComposer> is that, text only.
export { Composer, type ComposerProps } from './Composer'
export { TextComposer, type TextComposerProps } from './TextComposer'
export { type Draft, DraftStore, type PendingImage, type PendingReference, type SendSnapshot, draftStoreFor, useDraft, useDraftStore } from './drafts'
export { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, readImages, wireImage } from './images'
