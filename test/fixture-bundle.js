/**
 * A miniature stand-in for the shipped Web bundle.
 *
 * patchBundle() recognises the KaTeX wrapper by shape: a two-argument function
 * that renders through katex, retries leniently, then converts the HTML with
 * DOMParser and maps `Bb` over the child nodes. CI runs the patch tests against
 * this file, so they work without a DeepSeek Harness installation.
 *
 * The wrapper is named J2 because the patch replaces it in place and defines a
 * forwarding J2 in its stead, exactly as it does in the shipped bundle.
 */
const katexTheme = { className: 'shiki css-variables' }

function J2(tex, display) {
  let html
  try {
    html = Zm.renderToString(tex, { displayMode: display, throwOnError: true })
  } catch (strictError) {
    try {
      html = Zm.renderToString(tex, { displayMode: display, throwOnError: false })
    } catch (lenientError) {
      return []
    }
  }
  return [...new DOMParser().parseFromString(html, 'text/html').body.childNodes].map(Bb)
}

export { katexTheme, J2 }