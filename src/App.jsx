import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { useBarcodeScanner } from './hooks/useBarcodeScanner'
import { useNetworkStatus } from './hooks/useNetworkStatus'
import { useThermalPrinter } from './hooks/useThermalPrinter'
import { buildEscPosReceipt } from './utils/PosGenerator'
import { formatCurrency } from './utils/formatters'
import { syncCatalogMutations, syncOfflineOrders } from './api/client'
import { getCatalogMutations, loadCatalog, removeCatalogMutations, saveProductMutation } from './db/dexieDB'

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
const MANAGER_PIN = '2468'
const PRODUCT_COLORS = ['coffee', 'latte', 'cream', 'matcha', 'berry', 'pink', 'gold', 'peach', 'sage', 'green', 'honey', 'lemon']

function createOrderId() {
  return `J${Date.now().toString().slice(-7)}`
}

function createMutationId() {
  return globalThis.crypto?.randomUUID?.() ?? `catalog-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function createEmptyProduct() {
  return {
    name: '',
    category: 'Coffee',
    price: '',
    stock: '',
    lowStockThreshold: 5,
    barcode: '',
    note: '',
    emoji: '🛍️',
    color: PRODUCT_COLORS[Math.floor(Math.random() * PRODUCT_COLORS.length)],
    modifiers: undefined,
  }
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
  const [products, setProducts] = useState(PRODUCTS)
  const [catalogMutations, setCatalogMutations] = useState([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogMode, setCatalogMode] = useState(false)
  const [productForm, setProductForm] = useState(null)
  const [editingProductId, setEditingProductId] = useState(null)
  const [priceProduct, setPriceProduct] = useState(null)
  const [priceDraft, setPriceDraft] = useState('')
  const [barcodeCaptureMode, setBarcodeCaptureMode] = useState(false)
  const [pinDraft, setPinDraft] = useState('')
  const [pinError, setPinError] = useState('')
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

  const categoryNames = useMemo(() => [...new Set([...CATEGORIES.slice(1), ...products.map((product) => product.category)])], [products])
  const filteredProducts = useMemo(() => products.filter((product) => {
    const matchesCategory = category === 'All items' || product.category === category
    const query = search.trim().toLowerCase()
    return matchesCategory && (!query || product.name.toLowerCase().includes(query) || product.barcode.includes(query))
  }), [category, products, search])

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
    let active = true
    Promise.all([loadCatalog(PRODUCTS), getCatalogMutations()])
      .then(([storedProducts, storedMutations]) => {
        if (!active) return
        setProducts(storedProducts)
        setCatalogMutations(storedMutations)
        setCatalogLoaded(true)
      })
      .catch((error) => {
        console.error('Unable to load the local product catalog.', error)
        if (active) {
          setCatalogLoaded(true)
          showToast('Local catalog unavailable · using sample items for this session')
        }
      })
    return () => { active = false }
  }, [showToast])

  useEffect(() => {
    saveLocal(QUEUE_KEY, queuedOrders)
  }, [queuedOrders])

  useEffect(() => {
    saveLocal(HISTORY_KEY, orderHistory)
  }, [orderHistory])

  useEffect(() => {
    if (!isOnline || (queuedOrders.length === 0 && catalogMutations.length === 0) || syncing) return undefined
    const syncOrders = () => {
      setSyncing(true)
      Promise.all([
        queuedOrders.length ? syncOfflineOrders(queuedOrders) : Promise.resolve({ syncedOrderIds: [], syncedAt: new Date().toISOString() }),
        catalogMutations.length ? syncCatalogMutations(catalogMutations) : Promise.resolve({ syncedMutationIds: [], syncedAt: new Date().toISOString() }),
      ])
        .then(async ([ordersResult, mutationsResult]) => {
          const syncedOrders = new Set(ordersResult.syncedOrderIds)
          const syncedMutations = new Set(mutationsResult.syncedMutationIds)
          await removeCatalogMutations([...syncedMutations])
          setQueuedOrders((current) => current.filter((order) => !syncedOrders.has(order.id)))
          setCatalogMutations((current) => current.filter((mutation) => !syncedMutations.has(mutation.id)))
          setLastSynced(new Date(mutationsResult.syncedAt))
          showToast(`Synced ${syncedOrders.size} order${syncedOrders.size === 1 ? '' : 's'} and ${syncedMutations.size} catalog update${syncedMutations.size === 1 ? '' : 's'}`)
        })
        .catch((error) => {
          console.error('Offline order sync failed.', error)
          showToast('Order sync failed · your orders are still saved')
        })
        .finally(() => setSyncing(false))
    }
    syncTimer.current = window.setTimeout(syncOrders, 350)
    return () => window.clearTimeout(syncTimer.current)
  }, [catalogMutations, isOnline, queuedOrders, showToast, syncing])

  useEffect(() => {
    const handleSearchShortcut = (event) => {
      if (event.key === 'Escape' && barcodeCaptureMode) {
        setBarcodeCaptureMode(false)
        showToast('Barcode scan cancelled')
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [barcodeCaptureMode, showToast])

  useEffect(() => () => {
    window.clearTimeout(syncTimer.current)
    window.clearTimeout(toastTimer.current)
  }, [])

  const commitProduct = async (product, operation) => {
    const mutation = {
      id: createMutationId(),
      type: operation,
      product: { ...product },
      createdAt: new Date().toISOString(),
    }
    await saveProductMutation(product, mutation)
    setProducts((current) => {
      const exists = current.some((item) => item.id === product.id)
      return exists
        ? current.map((item) => item.id === product.id ? product : item)
        : [...current, product]
    })
    setCatalogMutations((current) => [...current, mutation])
  }

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
    if (catalogMode) return openProductEditor(product)
    if (product.stock === 0) return showToast(`${product.name} is out of stock`)
    if (!product.modifiers) return addProduct(product)
    const defaults = Object.fromEntries(Object.entries(product.modifiers).map(([name, options]) => [name, options[0]]))
    setModifierProduct(product)
    setModifierChoices(defaults)
    setModal('modifier')
  }

  const scanBarcode = useCallback((barcode) => {
    if (barcodeCaptureMode) {
      const duplicate = products.find((product) => product.barcode === barcode && product.id !== editingProductId)
      if (duplicate) {
        showToast(`Barcode already belongs to ${duplicate.name}`)
        return
      }
      setProductForm((current) => current ? { ...current, barcode } : current)
      setBarcodeCaptureMode(false)
      showToast(`Barcode ${barcode} added to product`)
      return
    }

    const product = products.find((item) => item.barcode === barcode)
    if (!product) return showToast(`No product found for ${barcode}`)
    if (catalogMode) {
      setEditingProductId(product.id)
      setProductForm({ ...product, price: String(product.price), stock: String(product.stock) })
      setModal('product')
      return
    }
    addProduct(product)
  }, [addProduct, barcodeCaptureMode, catalogMode, editingProductId, products, showToast])
  useBarcodeScanner(scanBarcode, () => barcodeCaptureMode)

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

  const finalizeOrder = async (payments) => {
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

    const quantityByProduct = new Map()
    cart.forEach((item) => quantityByProduct.set(item.productId, (quantityByProduct.get(item.productId) ?? 0) + item.quantity))
    const inventoryUpdates = [...quantityByProduct.entries()].map(async ([productId, quantity]) => {
      const product = products.find((item) => item.id === productId)
      if (!product) return
      const updatedProduct = { ...product, stock: Math.max(0, product.stock - quantity) }
      try {
        await commitProduct(updatedProduct, 'UPDATE_PRODUCT')
      } catch (error) {
        console.error('Unable to persist inventory after the sale.', error)
        showToast(`Sale completed; ${product.name} inventory could not be saved`)
      }
    })
    await Promise.all(inventoryUpdates)
  }

  const payCash = () => {
    const tendered = Number(cashTendered)
    if (!Number.isFinite(tendered) || tendered < total) return showToast('Cash received must cover the total')
    void finalizeOrder([{ method: 'Cash', amount: total, tendered, change: tendered - total }])
  }

  const paySplit = () => {
    const cash = Number(splitCash) || 0
    const card = Number(splitCard) || 0
    if (cash < 0 || card < 0 || Math.abs(cash + card - total) > 0.01) return showToast('Split amounts must add up to the total')
    void finalizeOrder([{ method: 'Cash', amount: cash }, { method: 'Card', amount: card }])
  }

  const payCard = () => {
    setCardStatus('inserting')
    window.setTimeout(() => setCardStatus('processing'), 850)
    window.setTimeout(() => {
      setCardStatus('approved')
      window.setTimeout(() => { void finalizeOrder([{ method: 'Card', amount: total }]) }, 650)
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

  const requestCatalogAccess = () => {
    if (catalogMode) {
      setCatalogMode(false)
      showToast('Catalog editing turned off')
      return
    }
    setPinDraft('')
    setPinError('')
    setModal('pin')
  }

  const verifyManagerPin = (event) => {
    event.preventDefault()
    if (pinDraft !== MANAGER_PIN) {
      setPinError('That PIN didn’t match. Try again.')
      return
    }
    setCatalogMode(true)
    setModal(null)
    showToast('Catalog edit mode enabled')
  }

  const openNewProduct = () => {
    setEditingProductId(null)
    setProductForm(createEmptyProduct())
    setBarcodeCaptureMode(false)
    setModal('product')
  }

  const openProductEditor = (product) => {
    setEditingProductId(product.id)
    setProductForm({
      ...product,
      price: String(product.price),
      stock: String(product.stock),
      lowStockThreshold: product.lowStockThreshold ?? 5,
    })
    setBarcodeCaptureMode(false)
    setModal('product')
  }

  const saveProductForm = async (event) => {
    event.preventDefault()
    const name = productForm.name.trim()
    const productCategory = productForm.category.trim()
    const price = Number(productForm.price)
    const stock = Number(productForm.stock)
    const lowStockThreshold = Number(productForm.lowStockThreshold)
    if (!name || !productCategory || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0 || !Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
      showToast('Enter a name, category, valid price, and whole-number inventory values')
      return
    }
    const barcode = productForm.barcode.trim()
    const duplicate = products.find((product) => product.barcode === barcode && product.id !== editingProductId)
    if (barcode && duplicate) {
      showToast(`Barcode already belongs to ${duplicate.name}`)
      return
    }
    const product = {
      ...productForm,
      id: editingProductId ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'}-${createMutationId().slice(-6)}`,
      name,
      category: productCategory,
      price,
      stock,
      lowStockThreshold,
      barcode,
      note: productForm.note.trim(),
      modifiers: editingProductId ? productForm.modifiers : undefined,
    }
    try {
      await commitProduct(product, editingProductId ? 'UPDATE_PRODUCT' : 'CREATE_PRODUCT')
      setCategory('All items')
      setSearch('')
      setBarcodeCaptureMode(false)
      setModal(null)
      showToast(editingProductId ? `${name} updated` : `${name} added to catalog`)
    } catch (error) {
      console.error('Unable to save the product catalog change.', error)
      showToast('Could not save product to local storage')
    }
  }

  const saveInlinePrice = async () => {
    const price = Number(priceDraft)
    if (!Number.isFinite(price) || price <= 0) {
      showToast('Enter a price greater than ₱0')
      return
    }
    try {
      await commitProduct({ ...priceProduct, price }, 'UPDATE_PRODUCT')
      showToast(`${priceProduct.name} price updated`)
      setModal(null)
      setPriceProduct(null)
    } catch (error) {
      console.error('Unable to save the inline product price.', error)
      showToast('Could not save price to local storage')
    }
  }

  const updatePriceKeypad = (key) => {
    if (key === 'clear') {
      setPriceDraft('')
      return
    }
    if (key === 'backspace') {
      setPriceDraft((current) => current.slice(0, -1))
      return
    }
    setPriceDraft((current) => {
      if (key === '.' && current.includes('.')) return current
      if (current.includes('.') && current.split('.')[1].length >= 2) return current
      return `${current}${key}`
    })
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
          <button className={`catalog-mode-toggle ${catalogMode ? 'active' : ''}`} onClick={requestCatalogAccess}>
            <span>{catalogMode ? '✎' : '▦'}</span>{catalogMode ? 'Done editing' : 'Edit catalog'}
          </button>
          <button className="shift-button" onClick={() => setModal('report')}><span>▤</span> Shift report</button>
          <div className="header-divider" />
          <button className={`connection-button ${isOnline ? 'is-online' : 'is-offline'}`} onClick={toggleConnection} title="Toggle simulated connection">
            <span className="connection-dot" />
            <span>{isOnline ? 'Online' : 'Offline'}</span>
          </button>
          <div className={`sync-chip ${queuedOrders.length + catalogMutations.length ? 'has-queue' : ''}`} title={`${queuedOrders.length} orders · ${catalogMutations.length} catalog updates${lastSynced ? ` · Last synced ${lastSynced.toLocaleTimeString()}` : ''}`}>
            <span>{syncing ? '↻' : '⇧'}</span>{queuedOrders.length + catalogMutations.length} pending
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

          {catalogMode && <div className="catalog-mode-banner"><span className="catalog-mode-icon">✎</span><div><strong>Catalog edit mode</strong><small>Tap a price to update it, or edit a product’s details and stock.</small></div><button onClick={openNewProduct}>＋ Add product</button></div>}

          <div className="catalog-tools">
            <div className="category-tabs" role="tablist" aria-label="Product categories">
              {['All items', ...categoryNames].map((item) => (
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

          <div className="menu-label"><span>{category === 'All items' ? 'ALL MENU' : category.toUpperCase()}</span><span>{filteredProducts.length} items <i>·</i> {catalogMode ? 'Catalog editing' : 'Tap to add'}</span></div>
          <div className="product-grid">
            {filteredProducts.map((product) => <ProductCard key={product.id} product={product} catalogMode={catalogMode} onClick={() => handleProductClick(product)} onEdit={() => openProductEditor(product)} onPriceClick={() => { setPriceProduct(product); setPriceDraft(String(product.price)); setModal('price') }} />)}
            {catalogMode && <button className="add-product-tile" onClick={openNewProduct}><span>＋</span><strong>Add new item</strong><small>Create a product for your menu</small></button>}
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

      {modal === 'pin' && (
        <Modal onClose={closeModal} className="pin-modal">
          <button className="modal-close" onClick={closeModal} aria-label="Close">×</button>
          <div className="manager-lock">⌑</div>
          <div className="modal-heading pin-heading"><div className="eyebrow">MANAGER ACCESS</div><h2>Unlock the catalog</h2><p>Enter your manager PIN to edit products and inventory.</p></div>
          <form onSubmit={verifyManagerPin}>
            <label className="form-field"><span>Manager PIN</span><input autoFocus inputMode="numeric" type="password" maxLength={8} value={pinDraft} onChange={(event) => { setPinDraft(event.target.value); setPinError('') }} placeholder="Enter PIN" /></label>
            {pinError && <p className="form-error">{pinError}</p>}
            <button className="modal-primary" type="submit">Unlock edit mode <span>→</span></button>
            <p className="pin-hint">Ask your manager for an authorized PIN.</p>
          </form>
        </Modal>
      )}

      {modal === 'product' && productForm && (
        <Modal onClose={() => { setBarcodeCaptureMode(false); closeModal() }} className="product-form-modal">
          <div className="modal-heading checkout-title"><div><div className="eyebrow">{editingProductId ? 'CATALOG · EDIT ITEM' : 'CATALOG · NEW ITEM'}</div><h2>{editingProductId ? 'Edit product' : 'Add a product'}</h2><p>Product details and inventory are saved on this device.</p></div><button className="modal-close" onClick={() => { setBarcodeCaptureMode(false); closeModal() }} aria-label="Close">×</button></div>
          <form className="product-form" onSubmit={saveProductForm}>
            <label className="form-field"><span>Product name <b>*</b></span><input autoFocus maxLength={60} value={productForm.name} onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Iced vanilla latte" required /></label>
            <div className="form-row">
              <label className="form-field"><span>Category <b>*</b></span><input list="product-category-options" value={productForm.category} onChange={(event) => setProductForm((current) => ({ ...current, category: event.target.value }))} placeholder="Choose or type a category" required /><datalist id="product-category-options">{categoryNames.map((name) => <option key={name} value={name} />)}</datalist></label>
              <label className="form-field"><span>Price (PHP) <b>*</b></span><span className="form-input-prefix">₱<input inputMode="decimal" type="number" min="0.01" step="0.01" value={productForm.price} onChange={(event) => setProductForm((current) => ({ ...current, price: event.target.value }))} placeholder="0.00" required /></span></label>
            </div>
            <div className="form-row">
              <label className="form-field"><span>Stock count <b>*</b></span><input inputMode="numeric" type="number" min="0" step="1" value={productForm.stock} onChange={(event) => setProductForm((current) => ({ ...current, stock: event.target.value }))} placeholder="0" required /></label>
              <label className="form-field"><span>Low-stock alert at</span><input inputMode="numeric" type="number" min="0" step="1" value={productForm.lowStockThreshold} onChange={(event) => setProductForm((current) => ({ ...current, lowStockThreshold: event.target.value }))} /></label>
            </div>
            <label className="form-field"><span>Short description <small>Optional</small></span><input maxLength={80} value={productForm.note ?? ''} onChange={(event) => setProductForm((current) => ({ ...current, note: event.target.value }))} placeholder="A quick note shown on the menu card" /></label>
            <div className="form-field"><span>Barcode / SKU <small>Optional</small></span><div className="barcode-entry"><input value={productForm.barcode} onChange={(event) => setProductForm((current) => ({ ...current, barcode: event.target.value }))} placeholder="Scan or enter a barcode" /><button type="button" onClick={(event) => { event.currentTarget.blur(); setBarcodeCaptureMode(true); showToast('Ready to scan · scan a barcode now') }}>▥ <span>Scan barcode</span></button></div>{barcodeCaptureMode && <small className="scan-hint">Scanner ready — scan the product barcode. Press Escape to cancel.</small>}</div>
            <div className="product-form-note"><span>▤</span><span>Inventory changes save locally first and sync when a connection is available.</span></div>
            <button className="modal-primary" type="submit" disabled={!catalogLoaded}>{editingProductId ? 'Save product changes' : 'Add product to catalog'} <span>→</span></button>
          </form>
        </Modal>
      )}

      {modal === 'price' && priceProduct && (
        <Modal onClose={closeModal} className="price-keypad-modal">
          <button className="modal-close" onClick={closeModal} aria-label="Close">×</button>
          <div className="modal-heading pin-heading"><div className="eyebrow">QUICK PRICE EDIT</div><h2>{priceProduct.name}</h2><p>Set a new price in Philippine pesos.</p></div>
          <label className="price-display"><span>₱</span><input autoFocus inputMode="decimal" value={priceDraft} onChange={(event) => setPriceDraft(event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))} aria-label="New product price" /></label>
          <div className="price-keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'backspace'].map((key) => <button type="button" key={key} onClick={() => updatePriceKeypad(key)}>{key === 'backspace' ? '⌫' : key}</button>)}</div>
          <div className="price-keypad-actions"><button onClick={() => setPriceDraft('')}>Clear</button><button className="modal-primary" onClick={saveInlinePrice}>Save price <span>→</span></button></div>
        </Modal>
      )}

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

function ProductCard({ product, catalogMode, onClick, onEdit, onPriceClick }) {
  const lowStockThreshold = product.lowStockThreshold ?? 5
  const lowStock = product.stock <= lowStockThreshold
  return (
    <article className={`product-card ${catalogMode ? 'catalog-edit-card' : ''}`}>
      <button className="product-card-main" onClick={onClick} aria-label={catalogMode ? `Edit ${product.name}` : `Add ${product.name}, ${formatCurrency(product.price)}`}>
        <div className={`product-art ${product.color}`}><span className="product-emoji">{product.emoji}</span><span className={`stock-badge ${lowStock ? 'low-stock' : ''}`}>{lowStock ? `Low · ${product.stock}` : `${product.stock} left`}</span>{product.modifiers && <span className="modifier-tag">CUSTOMIZE</span>}</div>
        <div className="product-details"><div><strong>{product.name}</strong><small>{product.note || product.category}</small></div></div>
      </button>
      {catalogMode
        ? <button className="product-price-editor" onClick={onPriceClick} aria-label={`Edit ${product.name} price`}>{formatCurrency(product.price)} <span>✎</span></button>
        : <span className="product-price-display">{formatCurrency(product.price)}</span>}
      {catalogMode
        ? <button className="edit-product-button" onClick={onEdit} aria-label={`Edit ${product.name} details`}>✎</button>
        : <span className="add-product">+</span>}
    </article>
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
