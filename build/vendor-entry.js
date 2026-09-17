// Bundled into public/vendor/libs.js by `npm run vendor`.
// Only the languages Fleet actually renders are included, to keep the bundle small.
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'

import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, language] of Object.entries({
  bash, css, diff, go, java, javascript, json, kotlin, markdown,
  plaintext, python, rust, sql, swift, typescript, xml, yaml,
})) hljs.registerLanguage(name, language)

hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['kt', 'kts'], { languageName: 'kotlin' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['rs'], { languageName: 'rust' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['patch'], { languageName: 'diff' })
hljs.configure({ ignoreUnescapedHTML: true })

const marked = new Marked({ gfm: true, breaks: true, async: false })

window.FleetLibs = { marked, DOMPurify, hljs }
// Every consumer is a deferred classic script, so they all run before DOMContentLoaded.
// Announcing readiness there guarantees their listeners are registered in time.
const announce = () => window.dispatchEvent(new Event('fleet-libs-ready'))
// A deferred script already runs at readyState "interactive", so only a fully loaded
// document may be announced to synchronously; otherwise wait for DOMContentLoaded.
if (document.readyState === 'complete') announce()
else document.addEventListener('DOMContentLoaded', announce, { once: true })
