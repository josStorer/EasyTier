<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { mobileVpnState } from '../composables/mobile_vpn'
import { startMobileConnection, stopMobileConnection } from '../composables/mobile_connection'

defineProps<{ profile?: string }>()
const { t, te } = useI18n()
const busy = ref(false)
async function connect() {
  busy.value = true
  try { await startMobileConnection() }
  catch { /* The controller exposes the error in the persistent status panel. */ }
  finally { busy.value = false }
}
async function stop() {
  try { await stopMobileConnection() }
  catch { /* Keep the error visible, including failed native cleanup. */ }
}
</script>

<template>
  <section class="p-3 border-b flex flex-col gap-2 min-w-0" aria-live="polite">
    <div class="flex flex-wrap gap-2 items-center justify-between">
      <strong>{{ t('mobile-vpn.' + mobileVpnState.phase) }}</strong>
      <div class="flex gap-2">
        <Button v-if="!mobileVpnState.enabled || mobileVpnState.phase === 'error'"
          :label="t('mobile-vpn.connect')" icon="pi pi-play" :loading="busy" size="small" @click="connect" />
        <Button v-if="mobileVpnState.enabled" :label="t('mobile-vpn.stop')" icon="pi pi-stop"
          severity="secondary" size="small" @click="stop" />
      </div>
    </div>
    <div v-if="profile" class="text-sm break-all">{{ t('config-server.active_profile') }}: {{ profile }}</div>
    <div v-if="mobileVpnState.ipv4" class="text-sm break-all">
      {{ mobileVpnState.ipv4 }} · {{ t('mobile-vpn.peers', { count: mobileVpnState.peers }) }}
    </div>
    <div v-if="mobileVpnState.attempt" class="text-sm">
      {{ t('mobile-vpn.retry_progress', { count: mobileVpnState.attempt, max: 60 }) }}
    </div>
    <div v-if="mobileVpnState.enabled" class="text-sm">
      {{ t('mobile-vpn.health_progress', { routes: mobileVpnState.routes, count: mobileVpnState.recovery }) }}
    </div>
    <small v-if="mobileVpnState.phase === 'connected'">{{ t('mobile-vpn.http_unverified') }}</small>
    <div v-if="mobileVpnState.error" role="alert" class="text-sm text-red-600 dark:text-red-400 break-all max-h-24 overflow-y-auto">
      {{ te('mobile-vpn.' + mobileVpnState.error) ? t('mobile-vpn.' + mobileVpnState.error) : mobileVpnState.error }}
    </div>
    <small v-if="mobileVpnState.phase === 'stopped'">{{ t('mobile-vpn.stopped_hint') }}</small>
  </section>
</template>
