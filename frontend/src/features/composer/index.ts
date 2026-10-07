// The composer's public surface. <Composer> sends to /api/managed/:id/messages; every
// managed console (Sessions, Day and thread, project manager) mounts it through
// session-header/SessionTail. The draft store and the image helpers are reusable by
// a composer that posts to another route, under its own draft key.
export { Composer, type ComposerProps } from './Composer'
export { type Draft, DraftStore, type PendingImage, type PendingReference, type SendSnapshot, draftStoreFor, useDraft, useDraftStore } from './drafts'
export { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, readImages, wireImage } from './images'
