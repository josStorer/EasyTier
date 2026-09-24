import type { NetworkTypes } from 'easytier-frontend-lib'
import { addPluginListener } from '@tauri-apps/api/core'
import { Utils } from 'easytier-frontend-lib'
import { reactive } from 'vue'
import {
  consume_vpn_tile_action,
  get_vpn_status,
  prepare_vpn,
  start_vpn,
  stop_vpn,
  type VpnTileAction,
} from 'tauri-plugin-vpnservice-api'
import { collectNetworkInfo, getConfig, listNetworkInstanceIds, restartMobileNetwork, setTunFd } from './backend'

type Route = NetworkTypes.Route

interface vpnStatus {
  running: boolean
  ipv4Addr: string | null | undefined
  ipv4Cidr: number | null | undefined
  routes: string[]
  dns: string | null | undefined
}

let vpnReconcileTimer: ReturnType<typeof setTimeout> | null = null
const VPN_RECONCILE_INTERVAL_MS = 2000
const VPN_RECONCILE_MAX_ATTEMPTS = 60

let desiredVpnInstanceId: string | undefined
let activeVpnInstanceId: string | undefined
let vpnReconcileGeneration = 0
let vpnReconcileAttempts = 0
let vpnReconcileQueue: Promise<void> = Promise.resolve()
let vpnPermissionRequest: Promise<boolean> | null = null
let vpnTileActionHandler: ((action: VpnTileAction) => Promise<void>) | undefined
let vpnTileActionQueue: Promise<void> = Promise.resolve()
let suspended = true
let permissionDenied = false
let networkId: string | null | undefined
let networkAvailable = true
let networkChangeTimer: ReturnType<typeof setTimeout> | undefined

export const mobileVpnState = reactive({
  enabled: false,
  phase: 'stopped',
  error: '',
  attempt: 0,
  ipv4: '',
  peers: 0,
  changedAt: Date.now(),
})

export function setMobileVpnPhase(phase: string, error = '') {
  if (phase !== mobileVpnState.phase) mobileVpnState.changedAt = Date.now()
  mobileVpnState.phase = phase
  mobileVpnState.error = error
}

export function resumeMobileVpn() {
  permissionDenied = false
  suspended = false
  mobileVpnState.enabled = true
  vpnReconcileAttempts = 0
  setMobileVpnPhase('config')
}

export async function suspendMobileVpn() {
  suspended = true
  mobileVpnState.enabled = false
  beginVpnReconcile()
  clearTimeout(networkChangeTimer)
  mobileVpnState.ipv4 = ''
  mobileVpnState.peers = 0
  mobileVpnState.attempt = 0
  setMobileVpnPhase('stopped')
  // Stop immediately even while an old start is waiting for an authorization
  // dialog. Its generation check prevents it from starting after the answer.
  await doStopVpn(true)
}

const curVpnStatus: vpnStatus = {
  running: false,
  ipv4Addr: undefined,
  ipv4Cidr: undefined,
  routes: [],
  dns: undefined,
}

export function setMobileVpnTileActionHandler(
  handler?: (action: VpnTileAction) => Promise<void>,
) {
  vpnTileActionHandler = handler
}

export async function consumePendingMobileVpnTileAction() {
  const handler = vpnTileActionHandler
  if (!handler) {
    return false
  }

  const pending = await consume_vpn_tile_action()
  const action = pending?.action ?? (pending?.launchRequested ? 'start' : undefined)
  if (action !== 'start' && action !== 'stop') {
    return false
  }

  const run = vpnTileActionQueue
    .catch(error => console.error('previous VPN tile action failed', error))
    .then(() => handler(action))
  vpnTileActionQueue = run.catch(error => console.error('VPN tile action failed', error))
  await run
  return true
}

async function requestVpnPermissionOnce() {
  setMobileVpnPhase('permission')
  console.log('prepare vpn')
  const prepare_ret = await prepare_vpn()
  console.log('prepare vpn', JSON.stringify((prepare_ret)))
  if (prepare_ret?.errorMsg?.length) {
    throw new Error(prepare_ret.errorMsg)
  }

  const granted = prepare_ret?.granted === true
  if (!granted && !suspended) {
    permissionDenied = true
    setMobileVpnPhase('error', 'vpn_permission_denied')
    console.info('vpn permission request was denied or dismissed')
  }

  return granted
}

async function requestVpnPermission() {
  if (vpnPermissionRequest) {
    console.log('reuse pending vpn permission request')
    return await vpnPermissionRequest
  }

  const request = requestVpnPermissionOnce()
  vpnPermissionRequest = request
  try {
    return await request
  }
  finally {
    if (vpnPermissionRequest === request) {
      vpnPermissionRequest = null
    }
  }
}

function clearVpnReconcileTimer() {
  if (vpnReconcileTimer) {
    clearTimeout(vpnReconcileTimer)
    vpnReconcileTimer = null
  }
}

function beginVpnReconcile(instanceId?: string) {
  clearVpnReconcileTimer()
  desiredVpnInstanceId = instanceId
  vpnReconcileAttempts = 0
  vpnReconcileGeneration += 1
  return vpnReconcileGeneration
}

function isCurrentVpnReconcile(instanceId: string, generation: number) {
  return !suspended && desiredVpnInstanceId === (instanceId || undefined) && vpnReconcileGeneration === generation
}

function scheduleVpnReconcile(instanceId: string, generation: number, reason: string) {
  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  if (vpnReconcileAttempts >= VPN_RECONCILE_MAX_ATTEMPTS) {
    setMobileVpnPhase('error', reason)
    console.error(
      'vpn service reconcile stopped after maximum attempts',
      instanceId,
      VPN_RECONCILE_MAX_ATTEMPTS,
      reason,
    )
    return
  }

  clearVpnReconcileTimer()
  vpnReconcileAttempts += 1
  mobileVpnState.attempt = vpnReconcileAttempts
  console.log(
    'vpn service is not ready, retrying',
    JSON.stringify({
      instanceId,
      attempt: vpnReconcileAttempts,
      maxAttempts: VPN_RECONCILE_MAX_ATTEMPTS,
      delayMs: VPN_RECONCILE_INTERVAL_MS,
      reason,
    }),
  )
  vpnReconcileTimer = setTimeout(() => {
    vpnReconcileTimer = null
    void enqueueVpnReconcile(instanceId, generation).catch(error => {
      if (isCurrentVpnReconcile(instanceId, generation)) setMobileVpnPhase('error', String(error))
    })
  }, VPN_RECONCILE_INTERVAL_MS)
}

function resetVpnConfigStatus() {
  curVpnStatus.ipv4Addr = undefined
  curVpnStatus.ipv4Cidr = undefined
  curVpnStatus.routes = []
  curVpnStatus.dns = undefined
}

function syncVpnStatusFromNative(status: Awaited<ReturnType<typeof get_vpn_status>>) {
  curVpnStatus.running = status?.running ?? false
  if (!curVpnStatus.running) {
    activeVpnInstanceId = undefined
    resetVpnConfigStatus()
    return
  }

  const ipv4WithCidr = status?.ipv4Addr
  if (ipv4WithCidr?.length) {
    const [ipv4Addr, cidr] = ipv4WithCidr.split('/')
    curVpnStatus.ipv4Addr = ipv4Addr

    const parsedCidr = Number(cidr)
    curVpnStatus.ipv4Cidr = Number.isInteger(parsedCidr) ? parsedCidr : undefined
  }
  else {
    curVpnStatus.ipv4Addr = undefined
    curVpnStatus.ipv4Cidr = undefined
  }

  curVpnStatus.routes = [...(status?.routes ?? [])]
  curVpnStatus.dns = status?.dns ?? undefined
}

async function waitVpnStatus(target_status: boolean, timeout_sec: number) {
  const start_time = Date.now()
  while (true) {
    const native = await get_vpn_status()
    if ((native?.running ?? false) === target_status) {
      curVpnStatus.running = target_status
      return
    }
    if (Date.now() - start_time > timeout_sec * 1000) {
      throw new Error('wait vpn status timeout')
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

async function doStopVpn(force = false) {
  const wasRunning = curVpnStatus.running
  if (!force && !wasRunning) {
    activeVpnInstanceId = undefined
    return
  }
  console.log('stop vpn')
  const stop_ret = await stop_vpn()
  console.log('stop vpn', JSON.stringify((stop_ret)))
  await waitVpnStatus(false, 3)

  activeVpnInstanceId = undefined
  resetVpnConfigStatus()
}

async function doStartVpn(instanceId: string, generation: number, ipv4Addr: string, cidr: number, routes: string[], dns?: string) {
  if (curVpnStatus.running) {
    return
  }

  console.log('start vpn service', ipv4Addr, cidr, routes, dns)
  const request = {
    requestId: crypto.randomUUID(),
    ipv4Addr: `${ipv4Addr}/${cidr}`,
    routes,
    dns,
    disallowedApplications: ['com.kkrainbow.easytier'],
    mtu: 1300,
  }

  let start_ret = await start_vpn(request)
  console.log('start vpn response', JSON.stringify(start_ret))
  if (!isCurrentVpnReconcile(instanceId, generation)) {
    await doStopVpn(true)
    return
  }
  if (start_ret?.errorMsg === 'need_prepare') {
    const granted = await requestVpnPermission()
    if (!granted) {
      throw new Error('vpn_permission_denied')
    }
    if (!isCurrentVpnReconcile(instanceId, generation)) return
    start_ret = await start_vpn(request)
    console.log('start vpn retry response', JSON.stringify(start_ret))
  }

  if (!isCurrentVpnReconcile(instanceId, generation)) {
    await doStopVpn(true)
    return
  }

  if (start_ret?.errorMsg?.length) {
    throw new Error(start_ret.errorMsg)
  }
  setMobileVpnPhase('starting')
  const deadline = Date.now() + 10000
  while (true) {
    if (!isCurrentVpnReconcile(instanceId, generation)) {
      await doStopVpn(true)
      return
    }
    const native = await get_vpn_status()
    if (native?.errorMsg) throw new Error(native.errorMsg)
    if (native?.running && native.requestId === request.requestId) {
      if (typeof native.fd !== 'number' || native.fd < 0) throw new Error('vpn_fd_unavailable')
      // Do not publish success until the matching instance accepted this TUN.
      await setTunFd(native.fd, instanceId)
      if (!isCurrentVpnReconcile(instanceId, generation)) {
        await doStopVpn(true)
        return
      }
      curVpnStatus.running = true
      break
    }
    if (Date.now() >= deadline) throw new Error('vpn_start_timeout')
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  curVpnStatus.ipv4Addr = ipv4Addr
  curVpnStatus.ipv4Cidr = cidr
  curVpnStatus.routes = routes
  curVpnStatus.dns = dns
  activeVpnInstanceId = instanceId
  mobileVpnState.ipv4 = ipv4Addr
  mobileVpnState.attempt = 0
  vpnReconcileAttempts = 0
  setMobileVpnPhase('connecting')
}

async function onVpnServiceStart(payload: unknown) {
  console.log('vpn service start', JSON.stringify(payload))
}

async function onVpnServiceStop(payload: unknown) {
  console.log('vpn service stop', JSON.stringify(payload))
  curVpnStatus.running = false
  activeVpnInstanceId = undefined
  resetVpnConfigStatus()
}

async function registerVpnServiceListener() {
  console.log('register vpn service listener')
  await addPluginListener(
    'vpnservice',
    'physical_network_changed',
    onPhysicalNetworkChange,
  )

  await addPluginListener(
    'vpnservice',
    'vpn_service_start',
    onVpnServiceStart,
  )

  await addPluginListener(
    'vpnservice',
    'vpn_service_stop',
    onVpnServiceStop,
  )

  await addPluginListener(
    'vpnservice',
    'vpn_tile_action',
    () => {
      void consumePendingMobileVpnTileAction().catch((error) => {
        console.error('consume VPN tile action failed', error)
      })
    },
  )
}

function getRoutesForVpn(routes: Route[] | undefined, node_config: NetworkTypes.NetworkConfig): string[] {
  const ret = []
  for (const r of routes ?? []) {
    for (let cidr of r.proxy_cidrs ?? []) {
      if (!cidr.includes('/')) {
        cidr += '/32'
      }
      ret.push(cidr)
    }
  }

  for (const route of node_config.routes ?? []) {
    ret.push(route)
  }

  if (node_config.enable_magic_dns) {
    ret.push('100.100.100.101/32')
  }

  // sort and dedup
  return Array.from(new Set(ret)).sort()
}

async function stopVpnOwnedByOtherInstance(instanceId: string, generation: number) {
  if (!isCurrentVpnReconcile(instanceId, generation))
    return false

  if (curVpnStatus.running && activeVpnInstanceId !== instanceId) {
    console.warn('vpn service owner changed', activeVpnInstanceId, instanceId)
    await doStopVpn()
  }

  return isCurrentVpnReconcile(instanceId, generation)
}

async function reconcileNetworkInstance(instanceId: string, generation: number) {
  if (!isCurrentVpnReconcile(instanceId, generation))
    return
  if (permissionDenied) return

  clearVpnReconcileTimer()
  if (!networkAvailable) {
    setMobileVpnPhase('waiting_network')
    return
  }

  if (!instanceId) {
    console.warn('vpn service skipped because instance id is empty')
    if (curVpnStatus.running) {
      await doStopVpn()
    }
    return
  }
  const config = await getConfig(instanceId)
  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  console.log('vpn service loaded config', instanceId, JSON.stringify({
    no_tun: config.no_tun,
    dhcp: config.dhcp,
    enable_magic_dns: config.enable_magic_dns,
  }))
  if (config.no_tun) {
    console.log('vpn service skipped because no_tun is enabled', instanceId)
    if (activeVpnInstanceId === instanceId) {
      await doStopVpn()
    }
    return
  }

  if (!await stopVpnOwnedByOtherInstance(instanceId, generation))
    return

  let curNetworkInfo
  try {
    curNetworkInfo = (await collectNetworkInfo(instanceId))?.info?.map?.[instanceId]
  }
  catch (e) {
    console.warn('vpn service network info query failed', instanceId, e)
    scheduleVpnReconcile(instanceId, generation, 'network_info_query_failed')
    return
  }

  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  if (!curNetworkInfo) {
    setMobileVpnPhase('config')
    scheduleVpnReconcile(instanceId, generation, 'network_info_unavailable')
    return
  }

  if (curNetworkInfo.error_msg?.length) {
    console.warn('vpn service skipped because network instance failed', instanceId, curNetworkInfo.error_msg)
    vpnReconcileAttempts = 0
    await doStopVpn()
    setMobileVpnPhase('error', curNetworkInfo.error_msg)
    return
  }

  const virtualIpv4 = curNetworkInfo.my_node_info?.virtual_ipv4
  const virtual_ip = virtualIpv4?.address?.addr ? Utils.ipv4ToString(virtualIpv4.address) : undefined

  if (!virtual_ip || !virtual_ip.length) {
    setMobileVpnPhase('address')
    scheduleVpnReconcile(
      instanceId,
      generation,
      config.dhcp ? 'dhcp_ipv4_unavailable' : 'static_ipv4_unavailable',
    )
    return
  }

  let network_length = virtualIpv4?.network_length
  if (!network_length) {
    network_length = 24
  }

  const routes = getRoutesForVpn(curNetworkInfo?.routes, config)

  const dns = config.enable_magic_dns ? '100.100.100.101' : undefined

  const ipChanged = virtual_ip !== curVpnStatus.ipv4Addr
  const cidrChanged = network_length !== curVpnStatus.ipv4Cidr
  const routesChanged = JSON.stringify(routes) !== JSON.stringify(curVpnStatus.routes)
  const dnsChanged = dns != curVpnStatus.dns
  const configChanged = ipChanged || cidrChanged || routesChanged || dnsChanged
  const shouldStartVpn = !curVpnStatus.running

  if (shouldStartVpn || configChanged) {
    console.info('vpn service virtual ip changed', JSON.stringify(curVpnStatus), virtual_ip)
    if (curVpnStatus.running) {
      try {
        await doStopVpn()
      }
      catch (e) {
        console.error(e)
      }
    }

    try {
      if (!isCurrentVpnReconcile(instanceId, generation))
        return

      await doStartVpn(instanceId, generation, virtual_ip, network_length, routes, dns)
      if (!isCurrentVpnReconcile(instanceId, generation) && activeVpnInstanceId === instanceId) {
        await doStopVpn()
      }
    }
    catch (e) {
      if (!isCurrentVpnReconcile(instanceId, generation)) return
      if (e instanceof Error && e.message === 'need_prepare') {
        console.info('vpn permission is required before starting the Android VPN service')
        return
      }
      if (e instanceof Error && e.message === 'vpn_permission_denied') {
        setMobileVpnPhase('error', e.message)
        console.info('vpn permission request was denied or dismissed')
        return
      }
      console.error('start vpn service failed', e)
      if (!isCurrentVpnReconcile(instanceId, generation)) return
      const message = e instanceof Error ? e.message : String(e)
      setMobileVpnPhase('error', message)
      await doStopVpn(true)
      scheduleVpnReconcile(instanceId, generation, message)
    }
  }
}

function enqueueVpnTask(task: () => Promise<void>) {
  const run = vpnReconcileQueue
    .catch((e) => {
      console.error('previous vpn service reconcile failed', e)
    })
    .then(task)
  vpnReconcileQueue = run.catch((e) => {
    console.error('vpn service reconcile failed', e)
  })
  return run
}

function enqueueVpnReconcile(instanceId: string, generation: number) {
  return enqueueVpnTask(() => reconcileNetworkInstance(instanceId, generation))
}

export async function onNetworkInstanceChange(instanceId: string) {
  if (suspended) return
  const generation = beginVpnReconcile(instanceId || undefined)

  if (instanceId && await isNoTunEnabled(instanceId)) {
    if (vpnReconcileGeneration !== generation)
      return

    if (activeVpnInstanceId === instanceId) {
      desiredVpnInstanceId = undefined
      await enqueueVpnReconcile('', generation)
      return
    }

    desiredVpnInstanceId = activeVpnInstanceId
    if (activeVpnInstanceId) {
      await enqueueVpnReconcile(activeVpnInstanceId, generation)
    }
    return
  }

  if (vpnReconcileGeneration !== generation)
    return

  await enqueueVpnReconcile(instanceId, generation)
}

export async function onNetworkInstanceUpdate(instanceId: string) {
  if (suspended || !instanceId || instanceId !== desiredVpnInstanceId)
    return

  await enqueueVpnReconcile(instanceId, vpnReconcileGeneration)
}

async function isNoTunEnabled(instanceId: string | undefined) {
  if (!instanceId) {
    return false
  }
  return (await getConfig(instanceId)).no_tun ?? false
}

async function findRunningTunInstanceId() {
  const instanceIds = await listNetworkInstanceIds()
  const runningIds = (instanceIds.running_inst_ids ?? []).map(Utils.UuidToStr)
  console.log('vpn service sync running instances', JSON.stringify(runningIds))

  for (const instanceId of runningIds) {
    if (await isNoTunEnabled(instanceId)) {
      continue
    }

    return instanceId
  }

  return undefined
}

export async function initMobileVpnService() {
  await registerVpnServiceListener()
  const native = await get_vpn_status()
  networkId = native?.networkId
  networkAvailable = native?.networkAvailable ?? true
}

export async function prepareVpnService(instanceId: string) {
  if (suspended) return
  if (await isNoTunEnabled(instanceId)) {
    return
  }

  const generation = beginVpnReconcile(instanceId)
  const stopPreviousOwner = enqueueVpnTask(async () => {
    await stopVpnOwnedByOtherInstance(instanceId, generation)
  })
  await Promise.all([requestVpnPermission(), stopPreviousOwner])
}

export async function syncMobileVpnService() {
  if (suspended) return
  syncVpnStatusFromNative(await get_vpn_status())
  const instanceId = await findRunningTunInstanceId()
  if (instanceId) {
    console.log('vpn service sync selected instance', instanceId)
    await onNetworkInstanceChange(instanceId)
    return
  }

  await onNetworkInstanceChange('')
}

export async function onPhysicalNetworkChange(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('available' in payload)
    || typeof payload.available !== 'boolean') return
  const nextId = 'networkId' in payload && typeof payload.networkId === 'string' ? payload.networkId : null
  const changed = networkId !== undefined && (nextId !== networkId || networkAvailable !== payload.available)
  networkId = nextId
  networkAvailable = payload.available
  if (changed || !networkAvailable) clearTimeout(networkChangeTimer)
  if (suspended) return
  if (!networkAvailable) {
    clearVpnReconcileTimer()
    setMobileVpnPhase('waiting_network')
    return
  }
  if (!changed) return
  setMobileVpnPhase('reconnecting')
  networkChangeTimer = setTimeout(() => {
    networkChangeTimer = undefined
    if (suspended) return
    const generation = beginVpnReconcile(desiredVpnInstanceId)
    void enqueueVpnTask(async () => {
      if (suspended || generation !== vpnReconcileGeneration) return
      await doStopVpn(true)
      if (suspended || generation !== vpnReconcileGeneration) return
      await restartMobileNetwork()
    }).then(() => syncMobileVpnService()).catch(error => {
      if (!suspended) setMobileVpnPhase('error', String(error))
    })
  }, 1000)
}

// Called by a single non-overlapping monitor, also recovering missed native events.
export async function refreshMobileVpnStatus() {
  const native = await get_vpn_status()
  await onPhysicalNetworkChange({ available: native?.networkAvailable ?? true, networkId: native?.networkId })
  if (suspended || !networkAvailable || networkChangeTimer) return
  if (!desiredVpnInstanceId) {
    await syncMobileVpnService()
    if (!desiredVpnInstanceId && mobileVpnState.phase === 'config'
      && Date.now() - mobileVpnState.changedAt > 15000) {
      mobileVpnState.error = 'config_wait_timeout'
    }
    return
  }
  if (permissionDenied || vpnReconcileTimer || vpnReconcileAttempts >= VPN_RECONCILE_MAX_ATTEMPTS) return
  if (!native?.running || !curVpnStatus.running) {
    if (mobileVpnState.error === 'vpn_permission_denied') return
    curVpnStatus.running = false
    await enqueueVpnReconcile(desiredVpnInstanceId, vpnReconcileGeneration)
    return
  }
  const info = (await collectNetworkInfo(desiredVpnInstanceId))?.info?.map?.[desiredVpnInstanceId]
  if (suspended) return
  if (info?.error_msg) {
    setMobileVpnPhase('error', info.error_msg)
    return
  }
  mobileVpnState.peers = info?.peers?.length ?? 0
  setMobileVpnPhase(mobileVpnState.peers ? 'connected' : 'connecting')
}
