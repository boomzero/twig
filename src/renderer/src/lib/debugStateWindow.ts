export function renderDebugStateWindow(
  targetWindow: Window,
  json: string,
  copyText: (text: string) => Promise<void>
): void {
  targetWindow.document.open()
  targetWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>twig State JSON</title>
        <style>
          body {
            margin: 0;
            padding: 20px;
            font-family: 'Courier New', monospace;
            background: #1e1e1e;
            color: #d4d4d4;
          }
          pre {
            margin: 0;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }
          .toolbar {
            position: sticky;
            top: 0;
            display: flex;
            align-items: center;
            gap: 12px;
            background: #2d2d30;
            padding: 10px;
            border-bottom: 1px solid #3e3e42;
            margin-bottom: 10px;
          }
          button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 14px;
          }
          button:hover { background: #1177bb; }
          button:disabled { cursor: wait; opacity: 0.7; }
          #copy-status[data-state='success'] { color: #89d185; }
          #copy-status[data-state='error'] { color: #f48771; }
        </style>
      </head>
      <body>
        <div class="toolbar">
          <button id="copy-state" type="button">Copy to Clipboard</button>
          <span id="copy-status" role="status" aria-live="polite"></span>
        </div>
        <pre id="state-json"></pre>
      </body>
    </html>
  `)
  targetWindow.document.close()

  const jsonElement = targetWindow.document.getElementById('state-json')
  const copyButton = targetWindow.document.getElementById('copy-state') as HTMLButtonElement | null
  const copyStatus = targetWindow.document.getElementById('copy-status')
  if (!jsonElement || !copyButton || !copyStatus) return

  // Presentation text is untrusted; render the snapshot as text, never HTML.
  jsonElement.textContent = json
  copyButton.addEventListener('click', () => {
    copyButton.disabled = true
    copyStatus.textContent = 'Copying…'
    copyStatus.dataset.state = ''
    void copyText(json)
      .then(() => {
        copyStatus.textContent = 'Copied!'
        copyStatus.dataset.state = 'success'
      })
      .catch((error: unknown) => {
        console.error('Failed to copy debug state:', error)
        copyStatus.textContent = 'Copy failed'
        copyStatus.dataset.state = 'error'
      })
      .finally(() => {
        copyButton.disabled = false
      })
  })
}
