import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { reactive } from 'vue'
import PrimeVue from 'primevue/config'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ConfigServerProfiles from '../../../easytier-gui/src/components/ConfigServerProfiles.vue'
import { normalizeConfigServerProfiles, validateConfigServerProfiles } from '../../../easytier-gui/src/composables/config_server_profiles'

describe('configuration server editor interactions', () => {
  it('adds, edits, selects, removes and persists profiles using real controls', async () => {
    const model = reactive(normalizeConfigServerProfiles({ config_server_url: 'alice' }))
    const wrapper = mount(ConfigServerProfiles, {
      props: { modelValue: model },
      global: {
        plugins: [PrimeVue, createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } })],
        components: { Button, InputText, Select },
      },
      attachTo: document.body,
    })
    try {
      await wrapper.findAll('button').find(button => button.text().includes('add_profile'))!.trigger('click')
      await flushPromises()
      const fields = wrapper.findAll('input')
      expect(fields).toHaveLength(4)
      await fields[fields.length - 2].setValue('Office ' + 'long name '.repeat(20))
      await fields[fields.length - 1].setValue('udp://office.example:22020/bob')
      validateConfigServerProfiles(model)
      expect(model.config_server_profiles).toHaveLength(2)
      expect(model.config_server_url).toBe('udp://office.example:22020/bob')

      // Open the real PrimeVue popup and choose the first saved profile.
      await wrapper.get('[role="combobox"]').trigger('click')
      await flushPromises()
      const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      expect(options.length).toBe(2)
      options[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      options[0].click()
      await flushPromises()
      validateConfigServerProfiles(model)
      expect(model.config_server_url).toBe('alice')

      await wrapper.get('[aria-label="config-server.remove_profile 1"]').trigger('click')
      validateConfigServerProfiles(model)
      expect(model.config_server_url).toBeUndefined()
      expect(model.config_server_profiles).toHaveLength(1)
      expect(normalizeConfigServerProfiles(JSON.parse(JSON.stringify(model)))).toEqual(model)
    } finally { wrapper.unmount() }
  })
})
