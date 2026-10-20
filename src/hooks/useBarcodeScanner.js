import { useEffect, useRef } from 'react'

const SCANNER_GAP_MS = 90
const MIN_BARCODE_LENGTH = 5

export function useBarcodeScanner(onScan, captureInput = () => false) {
  const callbackRef = useRef(onScan)
  const captureInputRef = useRef(captureInput)

  useEffect(() => {
    callbackRef.current = onScan
  }, [onScan])

  useEffect(() => {
    captureInputRef.current = captureInput
  }, [captureInput])

  useEffect(() => {
    let buffer = ''
    let lastKeyAt = 0

    const handleKeyDown = (event) => {
      const target = event.target
      const captureWhileFocused = captureInputRef.current()
      if (target instanceof HTMLElement && (target.isContentEditable || !captureWhileFocused && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        buffer = ''
        return
      }

      if (event.key === 'Enter') {
        if (captureWhileFocused) event.preventDefault()
        if (buffer.length >= MIN_BARCODE_LENGTH) callbackRef.current(buffer)
        buffer = ''
        lastKeyAt = 0
        return
      }

      if (event.key.length !== 1 || !/^[a-z0-9]$/i.test(event.key)) return
      if (captureWhileFocused) event.preventDefault()
      const now = performance.now()
      if (now - lastKeyAt > SCANNER_GAP_MS) buffer = ''
      buffer += event.key
      lastKeyAt = now
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}