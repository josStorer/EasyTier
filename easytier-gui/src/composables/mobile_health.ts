import type { NetworkTypes } from 'easytier-frontend-lib'

interface HealthInfo {
  error_msg?: string
  my_node_info?: Pick<NetworkTypes.NodeInfo, 'peer_id'>
  peers: { peer_id: number, conns: Pick<NetworkTypes.PeerConnInfo, 'conn_id' | 'stats' | 'loss_rate'>[] }[]
  routes: Pick<NetworkTypes.Route, 'peer_id' | 'next_hop_peer_id' | 'cost'>[]
}

export function createMobileHealth() {
  return {
    samples: new Map<string, { rx: string, changedAt: number }>(),
    lastSample: 0,
    unhealthySince: undefined as number | undefined,
    healthySince: undefined as number | undefined,
    recoveries: 0,
    nextRecoveryAt: 0,
  }
}

// A successful handshake is not proof of working heartbeats or route exchange.
// Idle core heartbeats back off to 32 seconds; allow 75 seconds without RX.
export function sampleMobileHealth(state: ReturnType<typeof createMobileHealth>,
  info: HealthInfo | undefined, now: number) {
  if (state.lastSample && now - state.lastSample > 15000) {
    state.samples.clear()
    state.unhealthySince = undefined
    state.healthySince = undefined
  }
  state.lastSample = now
  const samples = new Map<string, { rx: string, changedAt: number }>()
  const healthyPeers = new Set<number>()
  for (const peer of info?.peers ?? []) {
    for (const conn of peer.conns ?? []) {
      const key = `${peer.peer_id}:${conn.conn_id}`
      const rx = String(conn.stats?.rx_packets ?? 0)
      const previous = state.samples.get(key)
      const sample = previous?.rx === rx ? previous : { rx, changedAt: now }
      samples.set(key, sample)
      if (Number(conn.stats?.latency_us) > 0 && Number(rx) > 0
        && Number(conn.loss_rate ?? 0) < 1 && now - sample.changedAt < 75000) {
        healthyPeers.add(peer.peer_id)
      }
    }
  }
  state.samples = samples
  const routes = (info?.routes ?? []).filter(route => route.peer_id !== info?.my_node_info?.peer_id
    && route.cost >= 0 && (healthyPeers.has(route.next_hop_peer_id) || healthyPeers.has(route.peer_id)))
  const reason = !info || info.error_msg ? 'network_info_unavailable'
    : !healthyPeers.size ? 'waiting_heartbeat' : !routes.length ? 'waiting_routes' : 'healthy'
  const healthy = reason === 'healthy'
  if (healthy) {
    state.unhealthySince = undefined
    state.healthySince ??= now
    // A brief success must not reset the retry budget and cause a restart loop.
    if (now - state.healthySince >= 120000) state.recoveries = 0
  }
  else {
    state.healthySince = undefined
    state.unhealthySince ??= now
  }
  const recover = !healthy && now - state.unhealthySince! >= 45000
    && now >= state.nextRecoveryAt && state.recoveries < 3
  return { healthy, reason, peers: healthyPeers.size, routes: routes.length, recover,
    exhausted: !healthy && state.recoveries >= 3 && now - state.unhealthySince! >= 45000 }
}
