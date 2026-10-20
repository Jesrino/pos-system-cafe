const DATABASE_NAME = 'juniper-pos'
const DATABASE_VERSION = 1

let databasePromise

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'))
  })
}

function openDatabase() {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser.'))
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('products')) {
          database.createObjectStore('products', { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains('catalogMutations')) {
          database.createObjectStore('catalogMutations', { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        databasePromise = null
        reject(request.error ?? new Error('Unable to open the local catalog database.'))
      }
      request.onblocked = () => {
        databasePromise = null
        reject(new Error('The local catalog database is blocked by another open tab.'))
      }
    })
  }

  return databasePromise
}

export async function loadCatalog(seedProducts) {
  const database = await openDatabase()
  const transaction = database.transaction('products', 'readwrite')
  const completed = transactionDone(transaction)
  const store = transaction.objectStore('products')
  const existingProducts = await requestResult(store.getAll())
  if (existingProducts.length === 0) {
    seedProducts.forEach((product) => store.put(product))
    await completed
    return seedProducts
  }
  await completed
  return existingProducts
}

export async function saveProductMutation(product, mutation) {
  const database = await openDatabase()
  const transaction = database.transaction(['products', 'catalogMutations'], 'readwrite')
  transaction.objectStore('products').put(product)
  transaction.objectStore('catalogMutations').put(mutation)
  await transactionDone(transaction)
}

export async function getCatalogMutations() {
  const database = await openDatabase()
  const transaction = database.transaction('catalogMutations', 'readonly')
  const completed = transactionDone(transaction)
  const mutations = await requestResult(transaction.objectStore('catalogMutations').getAll())
  await completed
  return mutations
}

export async function removeCatalogMutations(mutationIds) {
  if (mutationIds.length === 0) return
  const database = await openDatabase()
  const transaction = database.transaction('catalogMutations', 'readwrite')
  const store = transaction.objectStore('catalogMutations')
  mutationIds.forEach((id) => store.delete(id))
  await transactionDone(transaction)
}
