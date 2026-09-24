<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConfigServerSettings } from '../composables/config_server_profiles'

const model = defineModel<ConfigServerSettings>({ required: true })
const { t } = useI18n()
const profiles = computed(() => model.value.config_server_profiles ?? [])

function addProfile() {
  const id = crypto.randomUUID()
  model.value.config_server_profiles = [...profiles.value, { id, name: '', url: '' }]
  model.value.selected_config_server_id = id
}

function removeProfile(id: string) {
  model.value.config_server_profiles = profiles.value.filter(profile => profile.id !== id)
  if (model.value.selected_config_server_id === id) {
    model.value.selected_config_server_id = undefined
    model.value.config_server_url = undefined
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 min-w-0">
    <label for="config-server-selection">{{ t('config-server.active_profile') }}</label>
    <Select id="config-server-selection" v-model="model.selected_config_server_id" :options="profiles"
      option-value="id" :option-label="profile => profile.name || profile.url || t('config-server.unnamed')"
      :placeholder="t('config-server.no_profile')" show-clear class="w-full min-w-0" />
    <div class="flex flex-col gap-3 max-h-[45vh] overflow-y-auto">
      <div v-for="(profile, index) in profiles" :key="profile.id" class="flex flex-col gap-2 border rounded p-3 min-w-0">
        <div class="flex gap-2 items-center">
          <InputText v-model="profile.name" :aria-label="t('config-server.profile_name') + ' ' + (index + 1)"
            :placeholder="t('config-server.profile_name')" class="flex-1 min-w-0" />
          <Button icon="pi pi-trash" :aria-label="t('config-server.remove_profile') + ' ' + (index + 1)"
            severity="danger" text @click="removeProfile(profile.id)" />
        </div>
        <InputText v-model="profile.url" :aria-label="t('config-server.address') + ' ' + (index + 1)"
          :placeholder="t('config-server.address_placeholder')" spellcheck="false" class="w-full min-w-0" />
      </div>
      <small v-if="!profiles.length">{{ t('config-server.no_profiles') }}</small>
    </div>
    <Button :label="t('config-server.add_profile')" icon="pi pi-plus" outlined @click="addProfile" />
    <small class="p-text-secondary whitespace-pre-wrap">{{ t('config-server.description') }}</small>
  </div>
</template>
