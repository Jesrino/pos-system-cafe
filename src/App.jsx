import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { useBarcodeScanner } from './hooks/useBarcodeScanner'
import { useNetworkStatus } from './hooks/useNetworkStatus'
import { useThermalPrinter } from './hooks/useThermalPrinter'
import { buildEscPosReceipt } from './utils/PosGenerator'
import { formatCurrency } from './utils/formatters'
import { syncOfflineOrders } from './api/client'

const PRODUCTS = [
  { id: 'espresso', name: 'Espresso', category: 'Coffee', price: 150, emoji: '☕', color: 'coffee', stock: 18, barcode: '1010001', note: 'Double shot · 2 oz' },
  { id: 'cappuccino', name: 'Cappuccino', category: 'Coffee', price: 220, emoji: '☕', color: 'latte', stock: 12, barcode: '1010002', note: 'Velvety steamed milk', modifiers: { Size: ['Regular', 'Large'], Milk: ['Whole', 'Oat', 'Almond'] } },
  { id: 'flat-white', name: 'Flat white', category: 'Coffee', price: 210, emoji: '🥛', color: 'cream', stock: 9, barcode: '1010003', note: 'Silky microfoam', modifiers: { Milk: ['Whole', 'Oat', 'Almond'] } },
  { id: 'matcha', name: 'Matcha latte', category: 'Coffee', price: 250, emoji: '🍵', color: 'matcha', stock: 7, barcode: '1010004', note: 'Ceremonial grade', modifiers: { Size: ['Regular', 'Large'], Milk: ['Whole', 'Oat', 'Almond'] } },
  { id: 'cold-brew', name: 'Cold brew', category: 'Cold drinks', price: 220, emoji: '🧋', color: 'berry', stock: 14, barcode: '1010005', note: '18-hour steep' },
  { id: 'strawberry-matcha', name: 'Strawberry matcha', category: 'Cold drinks', price: 280, emoji: '🍓', color: 'pink', stock: 6, barcode: '1010006', note: 'House strawberry foam', modifiers: { Milk: ['Whole', 'Oat', 'Almond'], Extras: ['Vanilla +₱25', 'Extra matcha +₱50'] } },
  { id: 'croissant', name: 'Butter croissant', category: 'Bakery', price: 170, emoji: '🥐', color: 'gold', stock: 11, barcode: '1010007', note: 'Baked fresh today' },
  { id: 'almond-croissant', name: 'Almond croissant', category: 'Bakery', price: 210, emoji: '🥐', color: 'peach', stock: 5, barcode: '1010008', note: 'Filled & dusted' },
  { id: 'banana-bread', name: 'Banana bread', category: 'Bakery', price: 190, emoji: '🍞', color: 'sage', stock: 8, barcode: '1010009', note: 'Walnut · house-made' },
  { id: 'avocado-toast', name: 'Avocado toast', category: 'Brunch', price: 420, emoji: '🥑', color: 'green', stock: 6, barcode: '1010010', note: 'Sourdough · chili oil', modifiers: { Extras: ['Poached egg +₱100', 'Feta +₱75', 'No chili'] } },
  { id: 'pancakes', name: 'Pancake stack', category: 'Brunch', price: 450, emoji: '🥞', color: 'honey', stock: 4, barcode: '1010011', note: 'Maple · seasonal fruit' },
  { id: 'lemonade', name: 'Pink lemonade', category: 'Cold drinks', price: 180, emoji: '🍋', color: 'lemon', stock: 10, barcode: '1010012', note: 'Fresh squeezed' },
]

const CATEGORIES = ['All items', 'Coffee', 'Bakery', 'Brunch', 'Cold drinks']
const TAX_RATE = 0.0825
const QUEUE_KEY = 'juniper-pos-queued-orders'
const HISTORY_KEY = 'juniper-pos-order-history'

function createOrderId() {
  return `J${Date.now().toString().slice(-7)}`
}

function readSaved(key) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : []
  } catch (error) {
    console.error(`Unable to read saved POS data (${key}).`, error)
    return []
  }
}

function saveLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.error(`Unable to save POS data (${key}).`, error)
  }
}

function App() {
  const actualOnline = useNetworkStatus()
  const printer = useThermalPrinter()
  const [onlineOverride, setOnlineOverride] = useState(null)
  const isOnline = onlineOverride === null ? actualOnline : onlineOverride
  const [category, setCategory] = useState('All items')
  const [search, setSearch] = useState('')
  const searchInputRef = useRef(null)
  const [cart, setCart] = useState([])
  const [discount, setDiscount] = useState(0)
  const [queuedOrders, setQueuedOrders] = useState(() => readSaved(QUEUE_KEY))
  const [orderHistory, setOrderHistory] = useState(() => readSaved(HISTORY_KEY))
  const [syncing, setSyncing] = useState(false)
  const [modal, setModal] = useState(null)
  const [modifierProduct, setModifierProduct] = useState(null)
  const [modifierChoices, setModifierChoices] = useState({})
  const [checkoutMode, setCheckoutMode] = useState('cash')
  const [cashTendered, setCashTendered] = useState('')
  const [splitCash, setSplitCash] = useState('')
  const [splitCard, setSplitCard] = useState('')
  const [cardStatus, setCardStatus] = useState('ready')
  const [receipt, setReceipt] = useState(null)
  const [toast, setToast] = useState('')
  const [lastSynced, setLastSynced] = useState(null)
  const syncTimer = useRef(null)
  const toastTimer = useRef(null)

  const filteredProducts = useMemo(() => PRODUCTS.filter((product) => {
    const matchesCategory = category === 'All items' || product.category === category
    const query = search.trim().toLowerCase()
    return matchesCategory && (!query || product.name.toLowerCase().includes(query) || product.barcode.includes(query))
  }), [category, search])

  const subtotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  const discountAmount = subtotal * discount / 100
  const taxable = subtotal - discountAmount
  const tax = taxable * TAX_RATE
  const total = taxable + tax
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0)

  const showToast = useCallback((message) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }, [])

  useEffect(() => {
    saveLocal(QUEUE_KEY, queuedOrders)
  }, [queuedOrders])

  useEffect(() => {
    saveLocal(HISTORY_KEY, orderHistory)
  }, [orderHistory])

  useEffect(() => {
    if (!isOnline || queuedOrders.length === 0 || syncing) return undefined
    const syncOrders = () => {
      setSyncing(true)
      syncOfflineOrders(queuedOrders)
        .then((result) => {
          const synced = new Set(result.syncedOrderIds)
          setQueuedOrders((current) => current.filter((order) => !synced.has(order.id)))
          setLastSynced(new Date(result.syncedAt))
          showToast('Offline orders synced successfully')
        })
        .catch((error) => {
          console.error('Offline order sync failed.', error)
          showToast('Order sync failed · your orders are still saved')
        })
        .finally(() => setSyncing(false))
    }
    syncTimer.current = window.setTimeout(syncOrders, 350)
    return () => window.clearTimeout(syncTimer.current)
  }, [isOnline, queuedOrders, showToast, syncing])

  useEffect(() => {
    const handleSearchShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  useEffect(() => () => {
    window.clearTimeout(syncTimer.current)
    window.clearTimeout(toastTimer.current)
  }, [])

  const addProduct = useCallback((product, choices = {}) => {
    const modifiers = Object.entries(choices).filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`)
    const extra = modifiers.reduce((amount, modifier) => {
      const match = modifier.match(/\+₱(\d+(?:\.\d+)?)/)
      return amount + (match ? Number(match[1]) : 0)
    }, 0)
    const key = `${product.id}-${modifiers.join('|')}`
    setCart((current) => {
      const existing = current.find((item) => item.key === key)
      if (existing) return current.map((item) => item.key === key ? { ...item, quantity: item.quantity + 1 } : item)
      return [...current, { key, productId: product.id, name: product.name, emoji: product.emoji, quantity: 1, unitPrice: product.price + extra, modifiers }]
    })
    showToast(`${product.name} added to order`)
  }, [showToast])

  const handleProductClick = (product) => {
    if (product.stock === 0) return showToast(`${product.name} is out of stock`)
    if (!product.modifiers) return addProduct(product)
    const defaults = Object.fromEntries(Object.entries(product.modifiers).map(([name, options]) => [name, options[0]]))
    setModifierProduct(product)
    setModifierChoices(defaults)
    setModal('modifier')
  }

  const scanBarcode = useCallback((barcode) => {
    const product = PRODUCTS.find((item) => item.barcode === barcode)
    if (!product) return showToast(`No product found for ${barcode}`)
    addProduct(product)
  }, [addProduct, showToast])
  useBarcodeScanner(scanBarcode)

  const changeQuantity = (key, amount) => {
    setCart((current) => current.map((item) => item.key === key ? { ...item, quantity: item.quantity + amount } : item).filter((item) => item.quantity > 0))
  }

  const beginCheckout = (mode) => {
    if (cart.length === 0) return
    setCheckoutMode(mode)
    setCashTendered(String(Math.ceil(total)))
    const half = Math.round(total * 50) / 100
    setSplitCash(half.toFixed(2))
    setSplitCard((total - half).toFixed(2))
    setCardStatus('ready')
    setModal('checkout')
  }

  const finalizeOrder = (payments) => {
    const order = {
      id: createOrderId(),
      createdAt: new Date().toISOString(),
      items: cart.map((item) => ({ ...item })),
      subtotal,
      discount: discountAmount,
      tax,
      total,
      payments,
      offline: !isOnline,
    }
    setOrderHistory((current) => [order, ...current])
    if (!isOnline) setQueuedOrders((current) => [...current, order])
    setReceipt(order)
    setCart([])
    setDiscount(0)
    setModal('receipt')
  }

  const payCash = () => {
    const tendered = Number(cashTendered)
    if (!Number.isFinite(tendered) || tendered < total) return showToast('Cash received must cover the total')
    finalizeOrder([{ method: 'Cash', amount: total, tendered, change: tendered - total }])
  }

  const paySplit = () => {
    const cash = Number(splitCash) || 0
    const card = Number(splitCard) || 0
    if (cash < 0 || card < 0 || Math.abs(cash + card - total) > 0.01) return showToast('Split amounts must add up to the total')
    finalizeOrder([{ method: 'Cash', amount: cash }, { method: 'Card', amount: card }])
  }

  const payCard = () => {
    setCardStatus('inserting')
    window.setTimeout(() => setCardStatus('processing'), 850)
    window.setTimeout(() => {
      setCardStatus('approved')
      window.setTimeout(() => finalizeOrder([{ method: 'Card', amount: total }]), 650)
    }, 1850)
  }

  const toggleConnection = () => {
    setOnlineOverride((current) => {
      const next = !(current === null ? actualOnline : current)
      showToast(next ? 'Connection restored · syncing queued orders' : 'Offline mode enabled · orders will be saved on this device')
      return next
    })
  }

  const closeModal = () => setModal(null)

  const handlePrinterAction = async () => {
    if (printer.connected) {
      try {
        await printer.disconnectPrinter()
        showToast('USB printer disconnected')
      } catch (error) {
        console.error('Unable to disconnect the thermal printer.', error)
        showToast(error.message)
      }
      return
    }
    if (!printer.usbSupported) {
      showToast('Browser print is ready · connect a USB printer in a supported browser')
      return
    }
    try {
      await printer.connectPrinter()
      showToast('Thermal printer connected')
    } catch (error) {
      if (error.name !== 'NotFoundError') {
        console.error('Unable to connect the thermal printer.', error)
        showToast(error.message)
      }
    }
  }

  const handlePrintReceipt = async () => {
    try {
      const method = await printer.printReceipt(receipt)
      if (method === 'usb') showToast('Receipt sent to thermal printer')
    } catch (error) {
      console.error('Unable to print the receipt.', error)
      showToast(error.message)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Juniper & Co home">
          <span className="brand-mark">j<span>.</span></span>
          <span className="brand-copy"><strong>juniper & co.</strong><small>NEIGHBORHOOD COFFEE</small></span>
        </a>
        <div className="topbar-center">
          <span className="location-mark">⌖</span>
          <span><strong>Eastside café</strong><small>Front counter · Register 01</small></span>
          <span className="open-pill"><i /> OPEN</span>
        </div>
        <div className="topbar-actions">
          <button className="shift-button" onClick={() => setModal('report')}><span>▤</span> Shift report</button>
          <div className="header-divider" />
          <button className={`connection-button ${isOnline ? 'is-online' : 'is-offline'}`} onClick={toggleConnection} title="Toggle simulated connection">
            <span className="connection-dot" />
            <span>{isOnline ? 'Online' : 'Offline'}</span>
          </button>
          <div className={`sync-chip ${queuedOrders.length ? 'has-queue' : ''}`} title={lastSynced ? `Last synced ${lastSynced.toLocaleTimeString()}` : 'Offline order sync queue'}>
            <span>{syncing ? '↻' : '⇧'}</span>{queuedOrders.length} pending
          </div>
          <div className="hardware-chip"><span className="hardware-icon">▥</span><span>Scanner</span><i /></div>
          <button className="hardware-chip printer-chip" onClick={handlePrinterAction} title={printer.connected ? 'Disconnect thermal printer' : 'Connect USB thermal printer'}><span className="hardware-icon">▤</span><span>{printer.connected ? 'Printer connected' : printer.usbSupported ? 'Connect printer' : 'Print ready'}</span><i /></button>
          <div className="avatar" title="Signed in as Alex Morgan">AM</div>
        </div>
      </header>

      <main className="workspace">
        <section className="catalog">
          <div className="catalog-heading">
            <div>
              <div className="eyebrow">TUESDAY, OCTOBER 20 <span>·</span> MORNING SERVICE</div>
              <h1>Good morning, Alex <span>☀️</span></h1>
              <p>Let’s make someone’s day a little better.</p>
            </div>
            <div className="today-stat"><span className="stat-icon">↗</span><span><small>TODAY’S SALES</small><strong>{formatCurrency(orderHistory.reduce((sum, order) => sum + order.total, 0))}</strong></span></div>
          </div>

          <div className="catalog-tools">
            <div className="category-tabs" role="tablist" aria-label="Product categories">
              {CATEGORIES.map((item) => (
                <button key={item} role="tab" aria-selected={category === item} className={`category-tab ${category === item ? 'active' : ''}`} onClick={() => setCategory(item)}>
                  {item === 'All items' ? '✦' : item === 'Coffee' ? '☕' : item === 'Bakery' ? '🥐' : item === 'Brunch' ? '🍳' : '🧋'} <span>{item}</span>
                </button>
              ))}
            </div>
            <label className="search-box">
              <span>⌕</span>
              <input ref={searchInputRef} aria-label="Search menu" placeholder="Search menu or scan code..." value={search} onChange={(event) => setSearch(event.target.value)} />
              {search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
              {!search && <kbd>⌘ K</kbd>}
            </label>
          </div>

          <div className="menu-label"><span>{category === 'All items' ? 'ALL MENU' : category.toUpperCase()}</span><span>{filteredProducts.length} items <i>·</i> Tap to add</span></div>
          <div className="product-grid">
            {filteredProducts.map((product) => <ProductCard key={product.id} product={product} onClick={() => handleProductClick(product)} />)}
            {filteredProducts.length === 0 && <div className="empty-search"><span>⌕</span><strong>No menu items found</strong><small>Try another search or scan a barcode.</small></div>}
          </div>
          <div className="catalog-footer"><span>♧</span> Freshly made, just for you <i>·</i> Juniper & Co. <span className="footer-shortcut">BARCODE SCANNER READY <b>↵</b></span></div>
        </section>

        <aside className="order-panel">
          <div className="order-heading">
            <div><div className="eyebrow">CURRENT SALE</div><h2>Your order <span className="order-number">#1048</span></h2></div>
            <button className="more-button" aria-label="Order options" onClick={() => setDiscount(discount === 10 ? 0 : 10)}>···</button>
          </div>
          <div className="order-meta"><span className="dine-pill"><i /> Dine in</span><button onClick={() => showToast('Order type: Dine in')}>⌄</button><span className="order-time">◷ &nbsp;Just now</span></div>
          <div className="cart-column-label"><span>ITEM</span><span>QTY</span><span>PRICE</span></div>

          <div className="cart-items">
            {cart.map((item) => (
              <div className="cart-row" key={item.key}>
                <div className="cart-product-icon">{item.emoji}</div>
                <div className="cart-item-info"><strong>{item.name}</strong>{item.modifiers.length > 0 && <small>{item.modifiers.join(' · ')}</small>}<button className="remove-item" onClick={() => setCart((current) => current.filter((entry) => entry.key !== item.key))}>Remove</button></div>
                <div className="quantity-control"><button aria-label={`Remove one ${item.name}`} onClick={() => changeQuantity(item.key, -1)}>−</button><span>{item.quantity}</span><button aria-label={`Add one ${item.name}`} onClick={() => changeQuantity(item.key, 1)}>+</button></div>
                <strong className="cart-line-total">{formatCurrency(item.unitPrice * item.quantity)}</strong>
              </div>
            ))}
            {cart.length === 0 && <div className="empty-cart"><div className="empty-cart-art">☕</div><strong>Your next great order starts here</strong><p>Tap any item to add it to the sale.</p><span>QUICK TIP · SCAN A BARCODE TO ADD</span></div>}
          </div>

          <button className={`discount-row ${discount ? 'discount-active' : ''}`} onClick={() => setDiscount(discount === 10 ? 0 : 10)}>
            <span><span className="discount-icon">%</span> Add a discount <small>{discount ? '10% applied · tap to remove' : 'Manager discount · 10%'}</small></span>
            <span>{discount ? `−${formatCurrency(discountAmount)}` : '＋'}</span>
          </button>

          <div className="totals">
            <div><span>Subtotal <small>{itemCount} items</small></span><span>{formatCurrency(subtotal)}</span></div>
            {discount > 0 && <div className="discount-total"><span>Discount (10%)</span><span>−{formatCurrency(discountAmount)}</span></div>}
            <div><span>Tax <small>8.25%</small></span><span>{formatCurrency(tax)}</span></div>
          </div>
          <div className="total-row"><span>Total due</span><strong>{formatCurrency(total)}</strong></div>

          <div className="checkout-actions">
            <div className="checkout-label"><span>FAST CHECKOUT</span><small>Choose payment method</small></div>
            <div className="payment-buttons">
              <button className="pay-cash" disabled={!cart.length} onClick={() => beginCheckout('cash')}><span>＄</span>Cash</button>
              <button className="pay-card" disabled={!cart.length} onClick={() => beginCheckout('card')}><span>▰</span>Card</button>
              <button className="pay-split" disabled={!cart.length} onClick={() => beginCheckout('split')}><span>◫</span>Split</button>
            </div>
            <button className="clear-order" disabled={!cart.length} onClick={() => { setCart([]); setDiscount(0); showToast('Order cleared') }}><span>⌫</span> Clear order</button>
          </div>
        </aside>
      </main>

      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}

      {modal === 'modifier' && modifierProduct && (
        <Modal onClose={closeModal} className="modifier-modal">
          <div className="modal-topline"><span className={`modal-product-art ${modifierProduct.color}`}>{modifierProduct.emoji}</span><button className="modal-close" onClick={closeModal} aria-label="Close">×</button></div>
          <div className="modal-heading"><div className="eyebrow">CUSTOMIZE YOUR ORDER</div><h2>{modifierProduct.name}</h2><p>{modifierProduct.note}</p></div>
          <div className="modifier-options">
            {Object.entries(modifierProduct.modifiers).map(([group, options]) => (
              <fieldset key={group}><legend>{group}<span>Choose one</span></legend>
                <div className="option-list">{options.map((option) => <button type="button" key={option} className={modifierChoices[group] === option ? 'selected' : ''} onClick={() => setModifierChoices((current) => ({ ...current, [group]: option }))}>{option}{modifierChoices[group] === option && <b>✓</b>}</button>)}</div>
              </fieldset>
            ))}
          </div>
          <button className="modal-primary" onClick={() => { addProduct(modifierProduct, modifierChoices); closeModal() }}>Add to order <span>{formatCurrency(modifierProduct.price + Object.values(modifierChoices).reduce((sum, option) => sum + (Number(option.match(/\+₱(\d+(?:\.\d+)?)/)?.[1]) || 0), 0))}</span></button>
        </Modal>
      )}

      {modal === 'checkout' && (
        <Modal onClose={closeModal} className="checkout-modal">
          <div className="modal-heading checkout-title"><div><div className="eyebrow">ORDER #1048 · {checkoutMode === 'cash' ? 'CASH PAYMENT' : checkoutMode === 'card' ? 'CARD PAYMENT' : 'SPLIT PAYMENT'}</div><h2>{checkoutMode === 'cash' ? 'Take payment' : checkoutMode === 'card' ? 'Card terminal' : 'Split this bill'}</h2><p>Complete payment for this order.</p></div><button className="modal-close" onClick={closeModal} aria-label="Close">×</button></div>
          <div className="checkout-due"><span>AMOUNT DUE</span><strong>{formatCurrency(total)}</strong><small>Includes {formatCurrency(tax)} tax</small></div>
          {checkoutMode === 'cash' && <div className="cash-flow">
            <label className="amount-input"><span>Cash received</span><div><span>₱</span><input autoFocus inputMode="decimal" value={cashTendered} onChange={(event) => setCashTendered(event.target.value)} /></div></label>
            <div className="quick-cash">{[total, 20, 50].filter((amount, index, array) => index === 0 || amount > total && array.indexOf(amount) === index).map((amount, index) => <button key={`${amount}-${index}`} onClick={() => setCashTendered(amount.toFixed(2))}>{index === 0 ? 'Exact' : formatCurrency(amount)}</button>)}</div>
            <div className="change-due"><span>Change due</span><strong>{formatCurrency(Math.max(0, (Number(cashTendered) || 0) - total))}</strong></div>
            <ChangeBreakdown amount={Math.max(0, Math.round(((Number(cashTendered) || 0) - total) * 100))} />
            <button className="modal-primary" onClick={payCash}>Complete cash sale <span>→</span></button>
          </div>}
          {checkoutMode === 'card' && <div className="terminal-flow">
            <div className={`terminal-illustration ${cardStatus}`}><div className="terminal-screen">{cardStatus === 'approved' ? '✓' : cardStatus === 'processing' ? '•••' : '▰'}</div><div className="terminal-base" /></div>
            <strong>{cardStatus === 'ready' ? 'Ready for card' : cardStatus === 'inserting' ? 'Insert or tap card' : cardStatus === 'processing' ? 'Processing payment…' : 'Payment approved'}</strong>
            <p>{cardStatus === 'ready' ? 'Ask the customer to tap, insert, or swipe.' : cardStatus === 'approved' ? 'You’re all set. Finalizing your receipt…' : 'Please keep the card near the terminal.'}</p>
            {cardStatus === 'ready' && <button className="modal-primary" onClick={payCard}>Start card payment <span>→</span></button>}
            {cardStatus !== 'ready' && <div className="terminal-progress"><i className={cardStatus === 'approved' ? 'complete' : ''} /><i className={cardStatus === 'processing' || cardStatus === 'approved' ? 'complete' : ''} /><i className={cardStatus === 'approved' ? 'complete' : ''} /></div>}
          </div>}
          {checkoutMode === 'split' && <div className="split-flow">
            <div className="split-presets"><span>SPLIT BETWEEN</span><button onClick={() => { const cash = Math.round(total * 50) / 100; setSplitCash(cash.toFixed(2)); setSplitCard((total - cash).toFixed(2)) }}>2 guests · 50/50</button><button onClick={() => { const cash = Math.round(total / 3 * 100) / 100; setSplitCash(cash.toFixed(2)); setSplitCard((total - cash).toFixed(2)) }}>1/3 cash · 2/3 card</button></div>
            <label className="split-input"><span className="split-method cash-method">₱</span><span>Cash</span><b>₱</b><input inputMode="decimal" value={splitCash} onChange={(event) => setSplitCash(event.target.value)} /></label>
            <label className="split-input"><span className="split-method card-method">▰</span><span>Card</span><b>₱</b><input inputMode="decimal" value={splitCard} onChange={(event) => setSplitCard(event.target.value)} /></label>
            <div className="split-summary"><span>Remaining</span><strong className={Math.abs(total - (Number(splitCash) + Number(splitCard))) < 0.01 ? 'balanced' : ''}>{formatCurrency(total - ((Number(splitCash) || 0) + (Number(splitCard) || 0)))}</strong></div>
            <button className="modal-primary" onClick={paySplit}>Complete split payment <span>→</span></button>
          </div>}
          <div className="secure-note"><span>⌑</span> Secure payment · {isOnline ? 'Terminal connected' : 'Offline mode'}</div>
        </Modal>
      )}

      {modal === 'receipt' && receipt && (
        <Modal onClose={closeModal} className="receipt-modal">
          <div className="receipt-heading"><div className="success-badge">✓</div><div className="eyebrow">PAYMENT COMPLETE</div><h2>Order is all yours.</h2><p>{receipt.offline ? 'Saved on this device · will sync when online' : 'Receipt is ready to print or share.'}</p><button className="modal-close" onClick={closeModal} aria-label="Close">×</button></div>
          <ReceiptPreview order={receipt} />
          <div className="receipt-actions"><button className="receipt-print" onClick={handlePrintReceipt}>▤ &nbsp; {printer.connected ? 'Print to USB' : 'Print receipt'}</button><button className="receipt-done" onClick={closeModal}>New order <span>→</span></button></div>
        </Modal>
      )}

      {modal === 'report' && (
        <Modal onClose={closeModal} className="report-modal">
          <div className="modal-heading checkout-title"><div><div className="eyebrow">TUESDAY · MORNING SHIFT</div><h2>Shift summary</h2><p>Sales snapshot and recent orders.</p></div><button className="modal-close" onClick={closeModal} aria-label="Close">×</button></div>
          <div className="report-stats">
            <div><small>NET SALES</small><strong>{formatCurrency(orderHistory.reduce((sum, order) => sum + order.total, 0))}</strong></div>
            <div><small>ORDERS</small><strong>{orderHistory.length}</strong></div>
            <div><small>AVG. ORDER</small><strong>{formatCurrency(orderHistory.length ? orderHistory.reduce((sum, order) => sum + order.total, 0) / orderHistory.length : 0)}</strong></div>
          </div>
          <div className="report-payments"><strong>Payment breakdown</strong>{['Cash', 'Card'].map((method) => {
            const amount = orderHistory.reduce((sum, order) => sum + order.payments.filter((payment) => payment.method === method).reduce((sub, payment) => sub + payment.amount, 0), 0)
            return <div key={method}><span>{method === 'Cash' ? '₱' : '▰'} {method}</span><strong>{formatCurrency(amount)}</strong></div>
          })}</div>
          <div className="history-list"><strong>Recent orders</strong>{orderHistory.slice(0, 5).map((order) => <div className="history-row" key={order.id}><span className="history-order">#{order.id.slice(-4)}</span><span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} items <small>· {new Date(order.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></span><strong>{formatCurrency(order.total)}</strong></div>)}{orderHistory.length === 0 && <p className="report-empty">No completed orders yet. Your shift starts with the next sale.</p>}</div>
          <button className="modal-primary" onClick={() => { closeModal(); showToast('Shift report closed · order history preserved') }}>Close shift report <span>→</span></button>
        </Modal>
      )}

      <div className="print-only">{receipt && <ReceiptPreview order={receipt} />}</div>
    </div>
  )
}

function ProductCard({ product, onClick }) {
  return (
    <button className="product-card" onClick={onClick} aria-label={`Add ${product.name}, ${formatCurrency(product.price)}`}>
      <div className={`product-art ${product.color}`}><span className="product-emoji">{product.emoji}</span><span className={`stock-badge ${product.stock <= 5 ? 'low-stock' : ''}`}>{product.stock <= 5 ? `Only ${product.stock}` : `${product.stock} left`}</span>{product.modifiers && <span className="modifier-tag">CUSTOMIZE</span>}</div>
      <div className="product-details"><div><strong>{product.name}</strong><small>{product.note}</small></div><span className="product-price">{formatCurrency(product.price)}</span></div>
      <span className="add-product">+</span>
    </button>
  )
}

function Modal({ children, onClose, className = '' }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={`modal-card ${className}`} role="dialog" aria-modal="true">{children}</section></div>
}

function ChangeBreakdown({ amount }) {
  if (amount <= 0) return null
  const denominations = [1000, 500, 100, 25, 10, 5, 1]
  const labels = ['$10', '$5', '$1', '25¢', '10¢', '5¢', '1¢']
  let remaining = amount
  const change = denominations.map((value) => {
    const count = Math.floor(remaining / value)
    remaining %= value
    return count
  })
  if (!change.some(Boolean)) return null
  return <div className="change-breakdown"><span>CHANGE BREAKDOWN</span><div>{change.map((count, index) => count > 0 && <small key={labels[index]}>{count} × {labels[index]}</small>)}</div></div>
}

function ReceiptPreview({ order }) {
  const receiptText = useMemo(() => buildEscPosReceipt(order), [order])
  return (
    <div className="receipt-paper">
      <div className="receipt-logo">juniper <span>&</span> co.</div><div className="receipt-subtitle">NEIGHBORHOOD COFFEE</div>
      <div className="receipt-rule" />
      <div className="receipt-center">EASTSIDE CAFÉ<br />214 Cedar Street · Portland, OR</div>
      <div className="receipt-rule dashed" />
      <div className="receipt-meta"><span>Order #{order.id.slice(-4)}</span><span>{new Date(order.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span></div>
      {order.items.map((item, index) => <div className="receipt-item" key={`${item.key}-${index}`}><div><span>{item.quantity} × {item.name}</span><strong>{formatCurrency(item.unitPrice * item.quantity)}</strong></div>{item.modifiers.map((modifier) => <small key={modifier}>{modifier}</small>)}</div>)}
      <div className="receipt-rule dashed" />
      <div className="receipt-line"><span>Subtotal</span><span>{formatCurrency(order.subtotal)}</span></div>
      {order.discount > 0 && <div className="receipt-line"><span>Discount</span><span>−{formatCurrency(order.discount)}</span></div>}
      <div className="receipt-line"><span>Tax</span><span>{formatCurrency(order.tax)}</span></div>
      <div className="receipt-line receipt-grand"><span>TOTAL</span><strong>{formatCurrency(order.total)}</strong></div>
      {order.payments.map((payment, index) => <div className="receipt-line" key={`${payment.method}-${index}`}><span>{payment.method}</span><span>{formatCurrency(payment.amount)}</span></div>)}
      {order.payments.some((payment) => payment.change > 0) && <div className="receipt-line"><span>Change</span><span>{formatCurrency(order.payments.reduce((sum, payment) => sum + (payment.change || 0), 0))}</span></div>}
      <div className="receipt-barcode" aria-label={`Order barcode ${order.id}`}>{'|||| ||| || |||| ||| || ||||'.split('').map((bar, index) => <i key={index} className={bar === ' ' ? 'barcode-gap' : ''} />)}</div>
      <div className="receipt-center receipt-thanks">THANK YOU FOR STOPPING BY<br />Have a lovely day ♡</div>
      <span className="receipt-escpos" aria-hidden="true">{receiptText.length} bytes · ESC/POS ready</span>
    </div>
  )
}

export default App
