import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileHealth, sampleMobileHealth } from './mobile_health'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => Promise<void>>()
  const configs = new Map<string, Record<string, unknown>>()
  const networkInfo = new Map<string, unknown>()

  return {
    listeners,
    configs,
    networkInfo,
    addPluginListener: vi.fn(async (_plugin: string, event: string, listener: (payload: unknown) => Promise<void>) => {
      listeners.set(event, listener)
    }),
    collectNetworkInfo: vi.fn(async (instanceId: string) => ({
      info: { map: { [instanceId]: networkInfo.get(instanceId) } },
    })),
    consumeVpnTileAction: vi.fn(async () => ({})),
    getConfig: vi.fn(async (instanceId: string) => configs.get(instanceId)),
    getVpnStatus: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({ running: false })),
    listNetworkInstanceIds: vi.fn<() => Promise<{ running_inst_ids: unknown[] }>>(async () => ({ running_inst_ids: [] })),
    prepareVpn: vi.fn(async () => ({ granted: true })),
    setTunFd: vi.fn(async () => undefined),
    restartMobileNetwork: vi.fn<() => Promise<void>>(async () => undefined),
    startVpn: vi.fn(async (_request: Record<string, unknown>) => {
      await listeners.get('vpn_service_start')?.({ fd: 1 })
      return {}
    }),
    stopVpn: vi.fn(async () => {
      await listeners.get('vpn_service_stop')?.({})
      return {}
    }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: mocks.addPluginListener,
}))

vi.mock('easytier-frontend-lib', () => ({
  Utils: {
    UuidToStr: (value: unknown) => String(value),
    ipv4ToString: (address: { addr: string }) => address.addr,
  },
}))

vi.mock('tauri-plugin-vpnservice-api', () => ({
  consume_vpn_tile_action: mocks.consumeVpnTileAction,
  get_vpn_status: mocks.getVpnStatus,
  prepare_vpn: mocks.prepareVpn,
  start_vpn: mocks.startVpn,
  stop_vpn: mocks.stopVpn,
}))

vi.mock('./backend', () => ({
  logMobileVpnDiagnostic: vi.fn(async () => undefined),
  collectNetworkInfo: mocks.collectNetworkInfo,
  getConfig: mocks.getConfig,
  listNetworkInstanceIds: mocks.listNetworkInstanceIds,
  setTunFd: mocks.setTunFd,
  restartMobileNetwork: mocks.restartMobileNetwork,
}))

function setConfig(instanceId: string, noTun = false) {
  mocks.configs.set(instanceId, {
    no_tun: noTun,
    dhcp: false,
    enable_magic_dns: false,
    routes: [],
  })
}

function setReady(instanceId: string, ipv4: string) {
  mocks.networkInfo.set(instanceId, {
    my_node_info: {
      virtual_ipv4: {
        address: { addr: ipv4 },
        network_length: 24,
      },
    },
    routes: [],
  })
}

async function loadVpnModule() {
  const mobileVpn = await import('./mobile_vpn')
  await mobileVpn.initMobileVpnService()
  mobileVpn.resumeMobileVpn()
  return mobileVpn
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  mocks.listeners.clear()
  mocks.configs.clear()
  mocks.networkInfo.clear()
  mocks.addPluginListener.mockClear()
  mocks.collectNetworkInfo.mockClear()
  mocks.consumeVpnTileAction.mockReset()
  mocks.consumeVpnTileAction.mockResolvedValue({})
  mocks.getConfig.mockClear()
  mocks.getVpnStatus.mockReset()
  mocks.getVpnStatus.mockResolvedValue({ running: false })
  mocks.listNetworkInstanceIds.mockReset()
  mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: [] })
  mocks.prepareVpn.mockReset().mockResolvedValue({ granted: true })
  mocks.setTunFd.mockReset().mockResolvedValue(undefined)
  mocks.restartMobileNetwork.mockReset().mockResolvedValue(undefined)
  mocks.startVpn.mockReset().mockImplementation(async request => {
    mocks.getVpnStatus.mockResolvedValue({ running: true, fd: 1, ...request })
    await mocks.listeners.get('vpn_service_start')?.({ fd: 1, requestId: request.requestId })
    return {}
  })
  mocks.stopVpn.mockReset().mockImplementation(async () => {
    mocks.getVpnStatus.mockResolvedValue({ running: false })
    await mocks.listeners.get('vpn_service_stop')?.({})
    return {}
  })
})

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('mobile VPN reconciliation ownership', () => {
  it('stops A before retrying an unavailable B, then starts B when it becomes ready', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(1)

    mocks.startVpn.mockClear()
    await vpn.onNetworkInstanceChange('B')

    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
    expect(mocks.startVpn).not.toHaveBeenCalled()

    setReady('B', '10.0.0.2')
    await vpn.onNetworkInstanceUpdate('B')

    expect(mocks.startVpn).toHaveBeenCalledTimes(1)
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ ipv4Addr: '10.0.0.2/24' }))
  })

  it('stops the previous owner during pre-run even if the new instance never reaches post-run', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    mocks.stopVpn.mockClear()

    await vpn.prepareVpnService('B')

    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
  })

  it('preserves the VPN while retrying the same instance', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    mocks.stopVpn.mockClear()
    mocks.networkInfo.delete('A')

    await vpn.onNetworkInstanceUpdate('A')

    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('ignores an update from an instance that no longer owns the VPN', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    await vpn.onNetworkInstanceChange('B')
    mocks.collectNetworkInfo.mockClear()

    await vpn.onNetworkInstanceUpdate('A')

    expect(mocks.collectNetworkInfo).not.toHaveBeenCalled()
  })

  it('does not apply an in-flight result after the desired instance changes', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    mocks.startVpn.mockClear()
    mocks.stopVpn.mockClear()

    interface NetworkInfoResponse { info: { map: Record<string, unknown> } }
    let resolveNetworkInfo: (value: NetworkInfoResponse) => void = () => undefined
    let markCollectStarted: () => void = () => undefined
    const collectStarted = new Promise<void>((resolve) => {
      markCollectStarted = resolve
    })
    mocks.collectNetworkInfo.mockImplementationOnce(async () => await new Promise<NetworkInfoResponse>((resolve) => {
      resolveNetworkInfo = resolve
      markCollectStarted()
    }))

    const staleUpdate = vpn.onNetworkInstanceUpdate('A')
    await collectStarted
    const switchToB = vpn.onNetworkInstanceChange('B')
    resolveNetworkInfo({
      info: {
        map: {
          A: {
            my_node_info: {
              virtual_ipv4: {
                address: { addr: '10.0.0.99' },
                network_length: 24,
              },
            },
            routes: [],
          },
        },
      },
    })

    await Promise.all([staleUpdate, switchToB])

    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
  })

  it('stops a native VPN with unknown ownership before retrying the selected instance', async () => {
    setConfig('A')
    mocks.getVpnStatus.mockResolvedValue({
      running: true,
      ipv4Addr: '10.0.0.1/24',
      routes: [],
    })
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()

    await vpn.syncMobileVpnService()

    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })
})

describe('mobile VPN tile action delivery', () => {
  it('does not consume a pending action before a handler is ready', async () => {
    const vpn = await loadVpnModule()

    expect(await vpn.consumePendingMobileVpnTileAction()).toBe(false)
    expect(mocks.consumeVpnTileAction).not.toHaveBeenCalled()
  })

  it('consumes and dispatches a pending action once a handler is registered', async () => {
    const vpn = await loadVpnModule()
    const handler = vi.fn(async () => undefined)
    mocks.consumeVpnTileAction.mockResolvedValue({ action: 'start' })
    vpn.setMobileVpnTileActionHandler(handler)

    expect(await vpn.consumePendingMobileVpnTileAction()).toBe(true)
    expect(handler).toHaveBeenCalledWith('start')
  })
})

describe('mobile VPN recovery and cancellation', () => {
  it('retries startup when network info is not ready yet', async () => {
    setConfig('A')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(vpn.mobileVpnState.phase).toBe('config')
    setReady('A', '10.0.0.1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.setTunFd).toHaveBeenCalledWith(1, 'A')
    expect(vpn.mobileVpnState.ipv4).toBe('10.0.0.1')
  })

  it('does not need a start event to discover and attach an established VPN', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.startVpn.mockImplementationOnce(async request => {
      mocks.getVpnStatus.mockResolvedValue({ running: true, fd: 0, ...request })
      return {}
    })
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.setTunFd).toHaveBeenCalledWith(0, 'A')
    expect(vpn.mobileVpnState.phase).toBe('connecting')
  })

  it('reports TUN attachment failure and closes the unusable VPN', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.setTunFd.mockRejectedValueOnce(new Error('attachment failed'))
    await vpn.onNetworkInstanceChange('A')
    expect(vpn.mobileVpnState.phase).toBe('error')
    expect(vpn.mobileVpnState.error).toBe('attachment failed')
    expect(mocks.stopVpn).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(vpn.mobileVpnState.phase).toBe('connecting')
  })

  it('stays stopped after a scheduled retry, network change, or late instance event', async () => {
    setConfig('A')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    await vpn.suspendMobileVpn()
    setReady('A', '10.0.0.1')
    await vpn.onNetworkInstanceChange('A')
    await vpn.onPhysicalNetworkChange({ available: true, networkId: 'cellular' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.restartMobileNetwork).not.toHaveBeenCalled()
    expect(vpn.mobileVpnState.phase).toBe('stopped')
  })

  it.each([true, false])('stops while permission is pending and ignores the late result %s', async (granted) => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    let approve!: (value: { granted: boolean }) => void
    mocks.startVpn.mockResolvedValueOnce({ errorMsg: 'need_prepare' })
    mocks.prepareVpn.mockImplementationOnce(() => new Promise(resolve => { approve = resolve }))
    const starting = vpn.onNetworkInstanceChange('A')
    await vi.advanceTimersByTimeAsync(0)
    await vpn.suspendMobileVpn()
    expect(vpn.mobileVpnState.phase).toBe('stopped')
    approve({ granted })
    await starting
    expect(vpn.mobileVpnState.phase).toBe('stopped')
    expect(mocks.startVpn).toHaveBeenCalledTimes(1)
    expect(mocks.setTunFd).not.toHaveBeenCalled()
  })

  it('does not repeatedly request denied permission', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.startVpn.mockResolvedValueOnce({ errorMsg: 'need_prepare' })
    mocks.prepareVpn.mockResolvedValue({ granted: false })
    await vpn.onNetworkInstanceChange('A')
    await vpn.refreshMobileVpnStatus()
    await vpn.onNetworkInstanceUpdate('A')
    await vi.advanceTimersByTimeAsync(30000)
    expect(mocks.prepareVpn).toHaveBeenCalledTimes(1)
    expect(vpn.mobileVpnState.error).toBe('vpn_permission_denied')
  })

  it('times out a stale native start without attaching its fd', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.startVpn.mockImplementationOnce(async () => {
      mocks.getVpnStatus.mockResolvedValue({ running: true, fd: 9, requestId: 'stale' })
      return {}
    })
    const starting = vpn.onNetworkInstanceChange('A')
    await vi.advanceTimersByTimeAsync(10100)
    await starting
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(vpn.mobileVpnState.error).toBe('vpn_start_timeout')
  })

  it('coalesces rapid physical network changes and ignores repeated snapshots', async () => {
    const vpn = await loadVpnModule()
    await vpn.onPhysicalNetworkChange({ available: true, networkId: 'wifi' })
    await vpn.onPhysicalNetworkChange({ available: false })
    expect(vpn.mobileVpnState.phase).toBe('waiting_network')
    await vpn.onPhysicalNetworkChange({ available: true, networkId: 'cellular' })
    await vpn.onPhysicalNetworkChange({ available: true, networkId: 'cellular' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.restartMobileNetwork).toHaveBeenCalledTimes(1)
  })

  it('cancels debounced network recovery on manual stop', async () => {
    const vpn = await loadVpnModule()
    await vpn.onPhysicalNetworkChange({ available: true, networkId: 'wifi' })
    await vpn.onPhysicalNetworkChange({ available: true, networkId: 'cellular' })
    await vpn.suspendMobileVpn()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.restartMobileNetwork).not.toHaveBeenCalled()
  })

  it('recovers persistent handshake-only connections at most three times', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    for (let i = 0; i < 180; i++) {
      await vpn.refreshMobileVpnStatus()
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(mocks.restartMobileNetwork).toHaveBeenCalledTimes(3)
    expect(vpn.mobileVpnState.phase).toBe('error')
    expect(vpn.mobileVpnState.error).toBe('recovery_exhausted')
  })

  it('keeps a failed recovery visible until an explicit retry', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    mocks.restartMobileNetwork.mockRejectedValueOnce(new Error('cleanup failed'))
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    for (let i = 0; i < 35; i++) {
      await vpn.refreshMobileVpnStatus()
      await vi.advanceTimersByTimeAsync(2000)
    }
    await vpn.onNetworkInstanceUpdate('A')
    expect(vpn.mobileVpnState.error).toBe('recovery_failed')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    vpn.resumeMobileVpn()
    await vpn.syncMobileVpnService()
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('counts failed status queries toward recovery without exposing raw errors', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    mocks.collectNetworkInfo.mockRejectedValue(new Error('RPC timeout with sensitive URL'))
    for (let i = 0; i < 23; i++) {
      await vpn.refreshMobileVpnStatus()
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(vpn.mobileVpnState.error).toBe('network_info_unavailable')
    await vpn.refreshMobileVpnStatus()
    expect(mocks.restartMobileNetwork).toHaveBeenCalledOnce()
    mocks.collectNetworkInfo.mockReset().mockImplementation(async instanceId => ({
      info: { map: { [instanceId]: mocks.networkInfo.get(instanceId) } },
    }))
  })

  it('does not attach a new VPN after stop during core recovery', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    let release!: () => void
    mocks.restartMobileNetwork.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    for (let i = 0; i < 23; i++) {
      await vpn.refreshMobileVpnStatus()
      await vi.advanceTimersByTimeAsync(2000)
    }
    const recovery = vpn.refreshMobileVpnStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.restartMobileNetwork).toHaveBeenCalledOnce()
    await vpn.suspendMobileVpn()
    release()
    await recovery
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(vpn.mobileVpnState.phase).toBe('stopped')
  })

  it('honors a pending tile stop over a simultaneous launcher start', async () => {
    const vpn = await loadVpnModule()
    const handler = vi.fn(async () => undefined)
    vpn.setMobileVpnTileActionHandler(handler)
    mocks.consumeVpnTileAction.mockResolvedValue({ action: 'stop', launchRequested: true })
    await vpn.consumePendingMobileVpnTileAction()
    expect(handler).toHaveBeenCalledWith('stop')
  })
})

describe('mobile heartbeat and route health', () => {
  function network(latency = 22000, loss = 0) {
    return {
      my_node_info: { peer_id: 1 },
      peers: [{ peer_id: 2, conns: [{ conn_id: 'conn', loss_rate: loss,
        stats: { latency_us: latency, rx_packets: 2, tx_packets: 2, rx_bytes: 100, tx_bytes: 100 } }] }],
      routes: [{ peer_id: 3, next_hop_peer_id: 2, cost: 2 }],
    }
  }

  it('requires a heartbeat and a reachable non-self route', () => {
    const state = createMobileHealth()
    expect(sampleMobileHealth(state, network(0), 1000).reason).toBe('waiting_heartbeat')
    expect(sampleMobileHealth(state, network(22000, 1), 2000).healthy).toBe(false)
    expect(sampleMobileHealth(state, { ...network(), routes: [] }, 3000).reason).toBe('waiting_routes')
    expect(sampleMobileHealth(state, { ...network(), routes: [{ peer_id: 1, next_hop_peer_id: 2, cost: 0 }] }, 4000).healthy).toBe(false)
    expect(sampleMobileHealth(state, network(), 5000).healthy).toBe(true)
  })

  it('allows idle 32-second heartbeats but detects frozen counters', () => {
    const state = createMobileHealth()
    for (let now = 1000; now < 76000; now += 2000) {
      expect(sampleMobileHealth(state, network(), now).healthy).toBe(true)
    }
    expect(sampleMobileHealth(state, network(), 77000).reason).toBe('waiting_heartbeat')
    const fresh = network()
    fresh.peers[0].conns[0].stats.rx_packets++
    expect(sampleMobileHealth(state, fresh, 79000).healthy).toBe(true)
  })

  it('does not charge time spent suspended and prunes old connections', () => {
    const state = createMobileHealth()
    sampleMobileHealth(state, network(0), 1000)
    expect(sampleMobileHealth(state, network(0), 100000).recover).toBe(false)
    sampleMobileHealth(state, undefined, 102000)
    expect(state.samples.size).toBe(0)
  })

  it('only resets the recovery budget after two minutes of sustained health', () => {
    const state = createMobileHealth()
    state.recoveries = 3
    for (let now = 1000; now <= 121000; now += 2000) {
      const info = network()
      info.peers[0].conns[0].stats.rx_packets = now
      sampleMobileHealth(state, info, now)
      expect(state.recoveries).toBe(now < 121000 ? 3 : 0)
    }
  })
})
