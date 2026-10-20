const SYNC_ENDPOINT = '/api/sync'

export async function syncOfflineOrders(orders) {
  await new Promise((resolve) => window.setTimeout(resolve, 750))

  return {
    endpoint: SYNC_ENDPOINT,
    method: 'POST',
    status: 200,
    database: 'PostgreSQL (simulated)',
    syncedOrderIds: orders.map((order) => order.id),
    syncedAt: new Date().toISOString(),
  }
}

export async function syncCatalogMutations(mutations) {
  await new Promise((resolve) => window.setTimeout(resolve, 650))

  return {
    endpoint: SYNC_ENDPOINT,
    method: 'POST',
    status: 200,
    database: 'PostgreSQL (simulated)',
    syncedMutationIds: mutations.map((mutation) => mutation.id),
    syncedAt: new Date().toISOString(),
  }
}