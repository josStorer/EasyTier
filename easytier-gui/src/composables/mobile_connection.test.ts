import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enabled: false,
  mode: { mode: 'normal', config_server_url: 'alice' },
  initWebClient: vi.fn(async (_url?: string): Promise<void> => undefined),
  mobileConnectionEnabled: vi.fn(async (): Promise<boolean> => false),
  setMobileConnectionEnabled: vi.fn(async (_enabled: boolean) => undefined),
  listNetworkInstanceIds: vi.fn(async () => ({ running_inst_ids: [], disabled_inst_ids: ['A'] })),
  getConfig: vi.fn(async () => ({ no_tun: false })),
  runNetworkInstance: vi.fn(async () => undefined),
  resumeMobileVpn: vi.fn(),
  suspendMobileVpn: vi.fn(async () => undefined),
  syncMobileVpnService: vi.fn(async () => undefined),
  setMobileVpnPhase: vi.fn(),
}))
vi.mock('easytier-frontend-lib', () => ({ Utils: { UuidToStr: (id: unknown) => id } }))
vi.mock('./backend', () => mocks)
vi.mock('./mode', () => ({ loadMode: () => mocks.mode }))
vi.mock('./config', () => ({ loadLastNetworkInstanceId: () => 'A' }))
vi.mock('./mobile_vpn', () => mocks)

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.enabled = false
  mocks.mode = { mode: 'normal', config_server_url: 'alice' }
  mocks.mobileConnectionEnabled.mockReset().mockImplementation(async () => mocks.enabled)
  mocks.setMobileConnectionEnabled.mockReset().mockImplementation(async enabled => { mocks.enabled = enabled })
  mocks.initWebClient.mockReset().mockResolvedValue(undefined)
})

describe('mobile user connection intent', () => {
  it('opens the selected URL once for concurrent connect requests', async () => {
    const controller = await import('./mobile_connection')
    await Promise.all([controller.startMobileConnection(), controller.startMobileConnection()])
    expect(mocks.enabled).toBe(true)
    expect(mocks.initWebClient).toHaveBeenCalledTimes(1)
    expect(mocks.initWebClient).toHaveBeenCalledWith('alice')
    expect(mocks.runNetworkInstance).not.toHaveBeenCalled()
  })

  it('reopens the last local network when no URL is selected', async () => {
    mocks.mode.config_server_url = ''
    const controller = await import('./mobile_connection')
    await controller.startMobileConnection()
    expect(mocks.getConfig).toHaveBeenCalledWith('A')
    expect(mocks.runNetworkInstance).toHaveBeenCalled()
    expect(mocks.initWebClient).not.toHaveBeenCalled()
  })

  it('does not enable or resume after stop wins an in-flight state lookup', async () => {
    let resolve!: (value: boolean) => void
    mocks.mobileConnectionEnabled.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const controller = await import('./mobile_connection')
    const starting = controller.startMobileConnection()
    await controller.stopMobileConnection()
    resolve(false)
    await starting
    expect(mocks.enabled).toBe(false)
    expect(mocks.resumeMobileVpn).not.toHaveBeenCalled()
    expect(mocks.initWebClient).not.toHaveBeenCalled()
  })

  it('does not sync a stopped session when an old URL initialization finishes', async () => {
    let finish!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    mocks.initWebClient.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; entered() }))
    const controller = await import('./mobile_connection')
    const starting = controller.startMobileConnection()
    await ready
    await controller.stopMobileConnection()
    expect(mocks.enabled).toBe(false)
    expect(mocks.syncMobileVpnService).not.toHaveBeenCalled()
    mocks.mode.config_server_url = 'bob'
    await controller.startMobileConnection()
    expect(mocks.initWebClient).toHaveBeenLastCalledWith('bob')
    expect(mocks.enabled).toBe(true)
    finish()
    await starting
    expect(mocks.enabled).toBe(true)
    expect(mocks.syncMobileVpnService).toHaveBeenCalledTimes(1)
  })

  it('cleans up and exposes configuration initialization errors', async () => {
    mocks.initWebClient.mockRejectedValueOnce(new Error('invalid configuration URL'))
    const controller = await import('./mobile_connection')
    await expect(controller.startMobileConnection()).rejects.toThrow('invalid configuration URL')
    expect(mocks.enabled).toBe(false)
    expect(mocks.suspendMobileVpn).toHaveBeenCalled()
    expect(mocks.setMobileVpnPhase).toHaveBeenLastCalledWith('error', 'invalid configuration URL')
  })
})
