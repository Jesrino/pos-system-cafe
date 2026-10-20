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