import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import PrimeVue from 'primevue/config'
import Button from 'primevue/button'
import MobileConnectionStatus from '../../../easytier-gui/src/components/MobileConnectionStatus.vue'
import { mobileVpnState } from '../../../easytier-gui/src/composables/mobile_vpn'
import { startMobileConnection, stopMobileConnection } from '../../../easytier-gui/src/composables/mobile_connection'
import en from '../src/locales/en.yaml'

vi.mock('../../../easytier-gui/src/composables/mobile_vpn', async () => {
  const { reactive } = await import('vue')
  return { mobileVpnState: reactive({ enabled: true, phase: 'recovering', error: '',
    ipv4: '10.144.0.3', peers: 0, routes: 0, attempt: 0, recovery: 1 }) }
})
vi.mock('../../../easytier-gui/src/composables/mobile_connection', () => ({
  startMobileConnection: vi.fn(async () => undefined),
  stopMobileConnection: vi.fn(async () => undefined),
}))

describe('mobile connection status controls', () => {
  it('allows stopping during recovery, retrying errors, and distinguishes HTTP from tunnel health', async () => {
    const wrapper = mount(MobileConnectionStatus, {
      props: { profile: 'A long profile '.repeat(25) },
      global: { plugins: [PrimeVue, createI18n({ legacy: false, locale: 'en', messages: { en } })],
        components: { Button } },
      attachTo: document.body,
    })
    try {
      expect(wrapper.text()).toContain('Cleaning up the old connection')
      await wrapper.findAll('button').find(button => button.text() === 'Stop')!.trigger('click')
      await flushPromises()
      expect(stopMobileConnection).toHaveBeenCalledOnce()

      mobileVpnState.phase = 'error'
      mobileVpnState.error = 'recovery_exhausted'
      mobileVpnState.recovery = 3
      await nextTick()
      expect(wrapper.get('[role="alert"]').text()).toContain('after 3 recovery attempts')
      await wrapper.findAll('button').find(button => button.text().includes('Connect'))!.trigger('click')
      await flushPromises()
      expect(startMobileConnection).toHaveBeenCalledOnce()

      mobileVpnState.phase = 'connected'
      mobileVpnState.error = ''
      mobileVpnState.peers = 2
      mobileVpnState.routes = 3
      await nextTick()
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('HTTP service has not been tested')
      expect(wrapper.text()).toContain('Reachable routes: 3')
    }
    finally { wrapper.unmount() }
  })
})
