// Pasted and dropped images: the browser-side checks the legacy composer made before
// anything is sent (the server sniffs the bytes again and has the last word, B02/B03).
import type { PendingImage } from './drafts'

export const MAX_IMAGES = 6
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface FileLike {
  readonly type: string
  readonly size: number
  readonly name: string
}

/** Why a file cannot join the draft, or null when it can. `count` is how many are attached already. */
export function refusal(file: FileLike, count: number): { message: string; stop: boolean } | null {
  if (!IMAGE_TYPES.has(file.type)) return { message: 'Only PNG, JPEG, GIF and WebP images can be attached.', stop: false }
  if (file.size > MAX_IMAGE_BYTES) return { message: `${file.name || 'That image'} is over 8 MB.`, stop: false }
  if (count >= MAX_IMAGES) return { message: `Up to ${MAX_IMAGES} images per message.`, stop: true }
  return null
}

const readDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'))
    reader.readAsDataURL(file)
  })

/**
 * Read the acceptable files into pending images, reporting each refusal through
 * `notice`, in the legacy order: wrong type and oversize skip that file, the seventh
 * image stops the batch.
 */
export async function readImages(
  files: readonly File[],
  already: number,
  notice: (message: string) => void,
  newId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<PendingImage[]> {
  const out: PendingImage[] = []
  for (const file of files) {
    const refused = refusal(file, already + out.length)
    if (refused) {
      notice(refused.message)
      if (refused.stop) break
      continue
    }
    try {
      const dataUrl = await readDataUrl(file)
      out.push({ id: newId(), mediaType: file.type, dataUrl, bytes: file.size, name: file.name || 'Pasted image' })
    } catch {
      notice(`${file.name || 'That image'} could not be read.`)
    }
  }
  return out
}

/** The wire form: base64 bytes and the browser's media type. */
export const wireImage = (image: PendingImage) => ({
  mediaType: image.mediaType,
  data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1),
})
