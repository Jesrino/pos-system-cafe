import { useCallback, useState } from 'react'
import { buildEscPosReceipt } from '../utils/PosGenerator'

const PRINTER_VENDOR_FILTERS = [0x04b8, 0x0519, 0x1504, 0x0483].map((vendorId) => ({ vendorId }))

export function useThermalPrinter() {
  const [device, setDevice] = useState(null)
  const usbSupported = typeof navigator !== 'undefined' && 'usb' in navigator

  const connectPrinter = useCallback(async () => {
    if (!usbSupported) throw new Error('WebUSB is unavailable in this browser. Use the receipt print dialog instead.')

    const selectedDevice = await navigator.usb.requestDevice({ filters: PRINTER_VENDOR_FILTERS })
    await selectedDevice.open()
    if (!selectedDevice.configuration) await selectedDevice.selectConfiguration(1)

    const output = selectedDevice.configuration.interfaces
      .flatMap((usbInterface) => usbInterface.alternates.map((alternate) => ({
        interfaceNumber: usbInterface.interfaceNumber,
        alternateSetting: alternate.alternateSetting,
        endpoint: alternate.endpoints.find((item) => item.direction === 'out' && item.type === 'bulk'),
      })))
      .find((candidate) => candidate.endpoint)

    if (!output) {
      await selectedDevice.close()
      throw new Error('The selected printer has no compatible USB bulk output interface.')
    }

    await selectedDevice.claimInterface(output.interfaceNumber)
    if (output.alternateSetting !== 0) {
      await selectedDevice.selectAlternateInterface(output.interfaceNumber, output.alternateSetting)
    }
    setDevice({ usbDevice: selectedDevice, endpointNumber: output.endpoint.endpointNumber })
    return selectedDevice
  }, [usbSupported])

  const disconnectPrinter = useCallback(async () => {
    if (!device) return
    if (device.usbDevice.opened) await device.usbDevice.close()
    setDevice(null)
  }, [device])

  const printReceipt = useCallback(async (order) => {
    if (!device) {
      window.print()
      return 'browser'
    }

    const bytes = buildEscPosReceipt(order)
    for (let offset = 0; offset < bytes.length; offset += 512) {
      const result = await device.usbDevice.transferOut(
        device.endpointNumber,
        bytes.slice(offset, offset + 512),
      )
      if (result.status !== 'ok') throw new Error(`Thermal printer write failed: ${result.status}.`)
    }
    return 'usb'
  }, [device])

  return { connectPrinter, disconnectPrinter, printReceipt, usbSupported, connected: Boolean(device) }
}