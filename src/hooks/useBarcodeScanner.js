import { useEffect, useRef } from 'react'

const SCANNER_GAP_MS = 90
const MIN_BARCODE_LENGTH = 5

export function useBarcodeScanner(onScan) {
  const callbackRef = useRef(onScan)

  useEffect(() => {
    callbackRef.current = onScan
  }, [onScan])

  useEffect(() => {
    let buffer = ''
    let lastKeyAt = 0

    const handleKeyDown = (event) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        buffer = ''
        return
      }

      if (event.key === 'Enter') {
        if (buffer.length >= MIN_BARCODE_LENGTH) callbackRef.current(buffer)
        buffer = ''
        lastKeyAt = 0
        return
      }

      if (event.key.length !== 1 || !/^[a-z0-9]$/i.test(event.key)) return
      const now = performance.now()
      if (now - lastKeyAt > SCANNER_GAP_MS) buffer = ''
      buffer += event.key
      lastKeyAt = now
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}