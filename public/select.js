'use strict'
// One dropdown for every <select> in Fleet.
//
// The native <select> stays in the page as the source of truth: code keeps reading
// .value, listening for "change" and re-rendering its options exactly as before. This
// adds a button trigger and a listbox beside it and keeps them in step. At touch widths
// CSS shows the native select instead, so phones get their own picker.
//
// An <option data-description="..."> shows a second line under its label.
;(() => {
  // Pure helpers, shared with the Node tests.
  // The next option whose label starts with what was typed, searching from the one after
  // the current, so typing the same letter again cycles through the matches.
  function match(labels, typed, from = -1) {
    const query = String(typed || '').toLowerCase()
    if (!query) return -1
    for (let step = 1; step <= labels.length; step++) {
      const i = (from + step) % labels.length
      if (labels[i] != null && String(labels[i]).toLowerCase().startsWith(query)) return i
    }
    return -1
  }
  // Below the trigger when the menu fits there, otherwise above when that has more room.
  function placement(trigger, menuHeight, viewportHeight, gap = 6) {
    const below = viewportHeight - trigger.bottom - gap, above = trigger.top - gap
    return menuHeight <= below || below >= above ? 'below' : 'above'
  }
  // A scroll only strands the menu when what scrolled holds the trigger (or is the page).
  // The console log following a stream, or a list restoring its scroll after a refresh,
  // moves nothing the menu is anchored to.
  function moves(scrolled, trigger) {
    return !!scrolled && typeof scrolled.contains === 'function' && scrolled.contains(trigger)
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { match, placement, moves }; return }

  // Published before any DOM work, so a page without a body still gets the namespace.
  window.FleetSelect = { enhance:select => enhance(select), close:() => close(false), isOpen:within => !!open && (!within || within.contains(open)) }
  const CHEVRON = '<svg class="fleet-select-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const CHECK = '<svg class="fleet-select-check" width="12" height="9" viewBox="0 0 12 9" fill="none" aria-hidden="true"><path d="M1 4.5L4.2 7.5L11 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
  const touch = () => matchMedia('(max-width:720px), (pointer:coarse)').matches
  const enhanced = new WeakMap()
  let open = null, uid = 0, typed = '', typedAt = 0

  const menu = document.createElement('div')
  menu.className = 'fleet-select-menu'
  menu.setAttribute('role', 'listbox')
  menu.tabIndex = -1
  menu.hidden = true

  // The words a person would use for this control: its aria-label, or its label's text
  // without the options inside it.
  function labelFor(select) {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label')
    const label = select.labels?.[0]
    if (!label) return ''
    const copy = label.cloneNode(true)
    copy.querySelectorAll('select, button, .note, .field-optional').forEach(el => el.remove())
    return copy.textContent.replace(/\s+/g, ' ').trim()
  }
  function sync(select) {
    const state = enhanced.get(select); if (!state) return
    const option = select.options[select.selectedIndex]
    const text = option ? option.textContent : ''
    state.value.textContent = text
    state.trigger.disabled = select.disabled
    state.trigger.title = select.title || ''
    const label = labelFor(select)
    state.trigger.setAttribute('aria-label', label ? `${label}: ${text}` : text)
    if (open === select) render()
  }
  function enhance(select) {
    if (enhanced.has(select) || select.multiple || select.size > 1 || select.dataset.native !== undefined) return
    const width = select.offsetWidth, parent = select.parentElement
    const block = !!parent && width > 0 && width >= parent.clientWidth * 0.9
    const trigger = document.createElement('button')
    trigger.type = 'button'
    // The select's own classes come along, so a rule written for .archive-days or
    // .ask-model styles the trigger as it styled the select.
    trigger.className = `fleet-select${block ? ' is-block' : ''}${select.className ? ` ${select.className}` : ''}`
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    if (!block && width) trigger.style.minWidth = `${width}px`
    const value = document.createElement('span')
    value.className = 'fleet-select-value'
    trigger.append(value)
    trigger.insertAdjacentHTML('beforeend', CHEVRON)
    select.after(trigger)
    select.classList.add('fleet-select-native')
    select.dataset.fleetSelect = ''
    enhanced.set(select, { trigger, value })
    // A programmatic select.value = x fires no event; mirror it anyway.
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    const index = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')
    Object.defineProperty(select, 'value', { configurable:true, get() { return proto.get.call(this) }, set(v) { proto.set.call(this, v); sync(this) } })
    Object.defineProperty(select, 'selectedIndex', { configurable:true, get() { return index.get.call(this) }, set(v) { index.set.call(this, v); sync(this) } })
    new MutationObserver(() => sync(select)).observe(select, { childList:true, subtree:true, attributes:true, characterData:true })
    select.addEventListener('change', () => sync(select))
    // A <label> click focuses the hidden select; hand that to the trigger.
    select.addEventListener('focus', () => { if (!touch()) trigger.focus() })
    trigger.addEventListener('click', () => open === select ? close(true) : show(select))
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(select) }
      else if (event.key.length === 1 && /\S/.test(event.key)) { event.preventDefault(); typeahead(select, event.key, true) }
    })
    sync(select)
  }

  const items = select => [...select.options].map((o, i) => ({ o, i })).filter(({ o }) => !o.hidden)
  function render() {
    const select = open, current = select.selectedIndex
    let html = '', group = null
    for (const { o, i } of items(select)) {
      const parent = o.parentElement?.tagName === 'OPTGROUP' ? o.parentElement : null
      if (parent && parent !== group) { html += `<div class="fleet-select-group" role="presentation">${esc(parent.label)}</div>`; group = parent }
      const description = o.dataset.description
      html += `<div class="fleet-select-option" role="option" id="fleet-option-${uid}-${i}" data-index="${i}" aria-selected="${i === current}"${o.disabled ? ' aria-disabled="true"' : ''}>${CHECK}<span class="fleet-select-text"><span>${esc(o.textContent)}</span>${description ? `<small>${esc(description)}</small>` : ''}</span></div>`
    }
    const scrolled = menu.scrollTop
    menu.innerHTML = html
    menu.scrollTop = scrolled
    activate(menu.dataset.active !== undefined ? Number(menu.dataset.active) : current)
  }
  function activate(i) {
    const el = menu.querySelector(`[data-index="${i}"]`)
    menu.querySelectorAll('.is-active').forEach(x => x.classList.remove('is-active'))
    if (!el) { menu.removeAttribute('aria-activedescendant'); delete menu.dataset.active; return }
    el.classList.add('is-active')
    menu.dataset.active = String(i)
    menu.setAttribute('aria-activedescendant', el.id)
    el.scrollIntoView({ block:'nearest' })
  }
  function position() {
    const { trigger } = enhanced.get(open), rect = trigger.getBoundingClientRect()
    // As wide as its trigger, a little wider for short ones; descriptions wrap rather
    // than stretch it across the page.
    menu.style.minWidth = `${Math.max(rect.width, 160)}px`
    menu.style.maxWidth = `${Math.min(Math.max(rect.width, 320), innerWidth - 16)}px`
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`
    const where = placement(rect, menu.offsetHeight, innerHeight)
    menu.dataset.placement = where
    menu.style.top = where === 'below' ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - 6 - menu.offsetHeight)}px`
  }
  function show(select) {
    if (open) close(false)
    if (select.disabled) return
    open = select; uid++
    delete menu.dataset.active
    const { trigger } = enhanced.get(select)
    menu.setAttribute('aria-label', labelFor(select) || 'Options')
    menu.hidden = false
    render()
    position()
    trigger.setAttribute('aria-expanded', 'true')
    menu.focus({ preventScroll:true })
  }
  function close(focusTrigger) {
    if (!open) return
    const { trigger } = enhanced.get(open) || {}
    menu.hidden = true
    trigger?.setAttribute('aria-expanded', 'false')
    open = null
    if (focusTrigger) trigger?.focus()
  }
  function choose(i) {
    const select = open, option = select?.options[i]
    if (!option || option.disabled) return
    const changed = select.selectedIndex !== i
    close(true)
    if (!changed) return
    select.selectedIndex = i
    select.dispatchEvent(new Event('input', { bubbles:true }))
    select.dispatchEvent(new Event('change', { bubbles:true }))
  }
  function move(step) {
    const list = items(open).filter(({ o }) => !o.disabled).map(({ i }) => i)
    if (!list.length) return
    const at = list.indexOf(Number(menu.dataset.active ?? open.selectedIndex))
    activate(step === Infinity ? list.at(-1) : step === -Infinity ? list[0] : list[Math.min(list.length - 1, Math.max(0, (at < 0 ? 0 : at) + step))])
  }
  // Type to jump. On a closed trigger it changes the value straight away, as a native
  // select does; in the open menu it moves the highlight.
  function typeahead(select, key, closed) {
    const now = Date.now()
    typed = now - typedAt > 600 ? key : typed + key
    typedAt = now
    const list = items(select).filter(({ o }) => !o.disabled)
    const from = closed ? list.findIndex(({ i }) => i === select.selectedIndex) : list.findIndex(({ i }) => i === Number(menu.dataset.active))
    const hit = match(list.map(({ o }) => o.textContent.trim()), typed, typed.length > 1 ? from - 1 : from)
    if (hit < 0) return
    if (!closed) return activate(list[hit].i)
    if (select.selectedIndex === list[hit].i) return
    select.selectedIndex = list[hit].i
    select.dispatchEvent(new Event('input', { bubbles:true }))
    select.dispatchEvent(new Event('change', { bubbles:true }))
  }

  menu.addEventListener('keydown', event => {
    if (!open) return
    const keys = { ArrowDown:1, ArrowUp:-1, PageDown:5, PageUp:-5, Home:-Infinity, End:Infinity }
    if (event.key in keys) { event.preventDefault(); return move(keys[event.key]) }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return choose(Number(menu.dataset.active)) }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return close(true) }
    if (event.key === 'Tab') return close(false)
    if (event.key.length === 1 && /\S/.test(event.key)) { event.preventDefault(); typeahead(open, event.key, false) }
  })
  menu.addEventListener('pointermove', event => {
    const el = event.target.closest('[data-index]')
    if (el && !el.hasAttribute('aria-disabled') && menu.dataset.active !== el.dataset.index) activate(Number(el.dataset.index))
  })
  menu.addEventListener('click', event => {
    const el = event.target.closest('[data-index]')
    if (el && !el.hasAttribute('aria-disabled')) choose(Number(el.dataset.index))
  })
  // Outside clicks close it; so does anything that moves the trigger from under it.
  document.addEventListener('pointerdown', event => {
    if (open && !menu.contains(event.target) && !enhanced.get(open)?.trigger.contains(event.target)) close(false)
  }, true)
  addEventListener('resize', () => close(false))
  document.addEventListener('scroll', event => { if (open && !menu.contains(event.target) && moves(event.target, enhanced.get(open)?.trigger)) close(false) }, true)

  function scan(root) {
    if (root.nodeType !== 1) return
    if (root.tagName === 'SELECT') enhance(root)
    else root.querySelectorAll?.('select').forEach(enhance)
  }
  const start = () => {
    document.body.append(menu)
    scan(document.body)
    new MutationObserver(records => {
      for (const r of records) for (const node of r.addedNodes) scan(node)
      // A menu whose select left the page, or whose trigger was hidden (a dialog closed,
      // a tab switched), closes with it.
      if (open && (!open.isConnected || !enhanced.get(open)?.trigger.offsetParent)) close(false)
    }).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['hidden','class','open'] })
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start)
})()
