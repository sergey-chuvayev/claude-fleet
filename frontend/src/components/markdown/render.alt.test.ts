// A23 regression, found by axe on the production build (image-alt, critical): an image
// in agent Markdown without alt text was read out as its URL.
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './render'

const images = (html: string) => {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return [...holder.querySelectorAll('img')]
}

describe('renderMarkdown images', () => {
  it('gives an image without alt text an empty one', () => {
    const [image] = images(renderMarkdown('Look: <img src="shot.png">'))
    expect(image?.getAttribute('alt')).toBe('')
  })

  it('keeps the description the agent wrote', () => {
    const [image] = images(renderMarkdown('![The failing test output](shot.png)'))
    expect(image?.getAttribute('alt')).toBe('The failing test output')
  })

  it('still strips the handler from a hostile image', () => {
    const [image] = images(renderMarkdown('<img src=x onerror=alert(1)>'))
    expect(image?.getAttribute('onerror')).toBeNull()
    expect(image?.getAttribute('alt')).toBe('')
  })
})
