import { Utils } from 'easytier-frontend-lib'
import {
  getConfig, initWebClient, listNetworkInstanceIds, mobileConnectionEnabled,
  runNetworkInstance, setMobileConnectionEnabled,
} from './backend'
import { loadLastNetworkInstanceId } from './config'
import { loadMode } from './mode'
import {
  resumeMobileVpn, setMobileVpnPhase, suspendMobileVpn, syncMobileVpnService,
} from './mobile_vpn'

let decision = 0
let pendingStart: Promise<void> | undefined
let pendingDecision = 0

export async function beginMobileConnection() {
  const currentDecision = decision
  const enabled = await mobileConnectionEnabled()
  if (currentDecision !== decision) return false
  if (!enabled) await setMobileConnectionEnabled(true)
  if (currentDecision !== decision) {
    await setMobileConnectionEnabled(false)
    return false
  }
  resumeMobileVpn()
  return true
}

export async function stopMobileConnection() {
  decision += 1
  // Cancel JS work synchronously, and close remote management in the backend.
  const results = await Promise.allSettled([suspendMobileVpn(), setMobileConnectionEnabled(false)])
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    setMobileVpnPhase('error', String(failure.reason))
    throw failure.reason
  }
}

export function startMobileConnection() {
  if (pendingStart && pendingDecision === decision) return pendingStart
  const currentDecision = ++decision
  pendingDecision = currentDecision
  const run = async () => {
    if (!await beginMobileConnection()) return
    if (currentDecision !== decision) return
    const mode = loadMode()
    if (mode.mode !== 'remote' && mode.config_server_url) {
      setMobileVpnPhase('config')
      await initWebClient(mode.config_server_url)
    }
    else {
      const response = await listNetworkInstanceIds()
      if (currentDecision !== decision) return
      const running = (response.running_inst_ids ?? []).map(Utils.UuidToStr)
      const configured = [...running, ...(response.disabled_inst_ids ?? []).map(Utils.UuidToStr)]
      const previous = loadLastNetworkInstanceId()
      const candidates = [...new Set([...(previous ? [previous] : []), ...configured])]
      let found = false
      for (const id of candidates) {
        if (!configured.includes(id)) continue
        const config = await getConfig(id)
        if (currentDecision !== decision) return
        if (config.no_tun) continue
        if (!running.includes(id)) await runNetworkInstance(config, true)
        found = true
        break
      }
      if (!found) throw new Error('vpn_no_network')
    }
    if (currentDecision !== decision) return
    await syncMobileVpnService()
  }
  pendingStart = run().catch(async (error: unknown) => {
    if (currentDecision === decision) {
      await stopMobileConnection()
      setMobileVpnPhase('error', error instanceof Error ? error.message : String(error))
    }
    throw error
  }).finally(() => {
    if (pendingDecision === currentDecision) pendingStart = undefined
  })
  return pendingStart
}
