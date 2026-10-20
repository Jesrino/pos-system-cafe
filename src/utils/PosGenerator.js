const ESC = 0x1b
const GS = 0x1d

function money(value) {
  return `₱${Number(value).toFixed(2)}`
}

function centered(text, width = 42) {
  const lines = []
  for (let start = 0; start < text.length; start += width) {
    const line = text.slice(start, start + width)
    lines.push(`${' '.repeat(Math.max(0, Math.floor((width - line.length) / 2)))}${line}`)
  }
  return lines.join('\n')
}

function receiptLine(label, value, width = 42) {
  const left = String(label)
  const right = String(value)
  return `${left.slice(0, Math.max(0, width - right.length - 1))}${' '.repeat(Math.max(1, width - left.length - right.length))}${right}`
}

export function buildEscPosReceipt(order) {
  const lines = [
    centered('JUNIPER & CO.'),
    centered('NEIGHBORHOOD COFFEE'),
    centered('Eastside Cafe - Portland, OR'),
    '-'.repeat(42),
    `Order #${String(order.id).slice(-4)}  ${new Date(order.createdAt).toLocaleString()}`,
    '-'.repeat(42),
    ...order.items.flatMap((item) => [
      receiptLine(`${item.quantity} x ${item.name}`, money(item.unitPrice * item.quantity)),
      ...item.modifiers.map((modifier) => `  ${modifier}`),
    ]),
    '-'.repeat(42),
    receiptLine('Subtotal', money(order.subtotal)),
    ...(order.discount > 0 ? [receiptLine('Discount', `-${money(order.discount)}`)] : []),
    receiptLine('Tax', money(order.tax)),
    receiptLine('TOTAL', money(order.total)),
    ...order.payments.map((payment) => receiptLine(payment.method, money(payment.amount))),
    '',
    centered('Thank you for stopping by!'),
    '',
    '',
  ]

  const encoder = new TextEncoder()
  const text = encoder.encode(`${lines.join('\n')}\n`)
  return new Uint8Array([ESC, 0x40, ESC, 0x61, 0x00, ...text, GS, 0x56, 0x00])
}