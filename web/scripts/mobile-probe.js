/**
 * Mobile layout probe — paste into the console on a page running the app.
 *
 * WHY THIS EXISTS
 *
 * The first responsive sweep (gate 18) measured one number,
 * `documentElement.scrollWidth - clientWidth`, at eight widths, and reported
 * zero problems. Three real defects were sitting in the build at the time:
 *
 *   - ProjectDetailPage's action column was laid out at ZERO height, with every
 *     button in it. It overflows nothing, so the width metric could not see it.
 *   - A generated project name (one word, no spaces) ran 79px past its box and
 *     pushed the page 59px wide. The harness clicked through the owner's real
 *     projects, whose names are short, so the case never appeared.
 *   - The video transport was bound to hover events. No pointer event of any
 *     kind was ever dispatched, so an interaction defect could not be found.
 *
 * A layout defect does not have to overflow. This probe looks for content the
 * layout has squeezed OUT of existence, and for controls no scroll can reach.
 *
 * USE
 *
 *   probeMobile()                    → measure the page as it is
 *   probeMobile.sweep([320, 390, …]) → same, at each width, in an iframe
 *
 * Run it on every reachable screen INCLUDING the ones that need opening — the
 * dialogs, the modals, the mid-render states. A screen that cannot be reached
 * from the list page is a screen this probe never sees.
 */

/* Plain JS meant to be pasted into a browser console, so no TS annotations. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

function describe(el) {
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
  return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} :: ${text}`
}

/**
 * @param {Window} w  the window to measure — an iframe's, for a sweep
 */
export function probeMobile(w = window) {
  const d = w.document
  const vh = w.innerHeight
  const controlsIn = (el) =>
    el.querySelectorAll('button,a,input,textarea,select,[role=button]').length

  const collapsed = [] // holds real content, laid out at nothing
  const starved = [] // a scroller far too small for what is inside it

  for (const el of d.querySelectorAll('div,aside,section,main,ul,form')) {
    const cs = w.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const n = controlsIn(el)
    if (!n) continue
    if (el.clientHeight <= 4 && el.scrollHeight > 24) {
      collapsed.push({
        h: el.clientHeight,
        content: el.scrollHeight,
        controls: n,
        el: describe(el)
      })
    } else if (
      /auto|scroll/.test(cs.overflowY) &&
      el.clientHeight < 60 &&
      el.scrollHeight > el.clientHeight + 40
    ) {
      starved.push({ h: el.clientHeight, content: el.scrollHeight, controls: n, el: describe(el) })
    }
  }

  const scrollers = [...d.querySelectorAll('*')].filter((el) => {
    const cs = w.getComputedStyle(el)
    return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight
  })
  // A control counts as visible if its own chain is visible — checking only the
  // element's computed opacity reports every button inside a faded-out overlay
  // (the auto-hiding video transport) as a defect.
  const shown = (el) => {
    for (let p = el; p && p !== d.body; p = p.parentElement) {
      const cs = w.getComputedStyle(p)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
      if (cs.pointerEvents === 'none') return false
    }
    return true
  }
  const controls = [...d.querySelectorAll('button,a[href],input,textarea')].filter((b) => {
    if (!shown(b)) return false
    const r = b.getBoundingClientRect()
    return r.width >= 1 && r.height >= 1
  })

  // Reachable = on screen at SOME scroll position. Measuring at one position
  // reports everything below the fold as unreachable.
  const seen = new Set()
  for (const at of ['top', 'bottom']) {
    for (const s of scrollers) s.scrollTop = at === 'top' ? 0 : s.scrollHeight
    for (const b of controls) {
      const r = b.getBoundingClientRect()
      if (r.top < vh && r.bottom > 0) seen.add(b)
    }
  }
  for (const s of scrollers) s.scrollTop = 0

  const widest = (() => {
    let worst = null
    for (const el of d.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.right > d.documentElement.clientWidth + 1 && (!worst || r.right > worst.right)) {
        worst = { right: Math.round(r.right), el: describe(el) }
      }
    }
    return worst
  })()

  return {
    overflowX: d.documentElement.scrollWidth - d.documentElement.clientWidth,
    widest,
    collapsed,
    starved,
    unreachable: controls.filter((b) => !seen.has(b)).map(describe)
  }
}

/**
 * Load the app at each width in an iframe and probe it. Same origin, so the
 * session, OPFS and service worker all apply; media queries see the iframe's
 * own width, which is what makes `lg:` behave as it does on a phone.
 */
probeMobile.sweep = async function sweep(widths = [320, 360, 390, 430, 540, 768, 834, 1023]) {
  const out = {}
  const f = document.createElement('iframe')
  f.style.cssText = 'position:fixed;right:0;top:0;z-index:2147483647;border:2px solid red'
  f.src = '/'
  document.body.appendChild(f)
  try {
    for (const width of widths) {
      f.style.width = `${width}px`
      // Short on purpose: a phone's visible area is the viewport MINUS the
      // browser toolbars, and that is where panes get squeezed to nothing.
      f.style.height = `${width < 500 ? 660 : 745}px`
      await new Promise((r) => f.addEventListener('load', r, { once: true }))
      await new Promise((r) => setTimeout(r, 2500))
      out[width] = probeMobile(f.contentWindow)
    }
  } finally {
    f.remove()
  }
  return out
}
