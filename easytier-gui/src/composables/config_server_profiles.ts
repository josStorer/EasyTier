export interface ConfigServerProfile {
  id: string
  name: string
  url: string
}

export interface ConfigServerSettings {
  config_server_url?: string
  config_server_profiles?: ConfigServerProfile[]
  selected_config_server_id?: string
}

// Keep the old URL field as the active value for desktop/service compatibility.
export function normalizeConfigServerProfiles<T extends ConfigServerSettings>(config: T): T & ConfigServerSettings {
  const profiles = (config.config_server_profiles ?? []).map(profile => ({ ...profile }))
  let selected = profiles.find(profile => profile.id === config.selected_config_server_id)
  if (!selected && config.config_server_url?.trim()) {
    selected = profiles.find(profile => profile.url === config.config_server_url?.trim())
    if (!selected) {
      selected = { id: crypto.randomUUID(), name: '', url: config.config_server_url.trim() }
      profiles.push(selected)
    }
  }
  return {
    ...config,
    config_server_profiles: profiles,
    selected_config_server_id: selected?.id,
    config_server_url: selected?.url,
  }
}

export function validateConfigServerProfiles(config: ConfigServerSettings) {
  const ids = new Set<string>()
  const urls = new Set<string>()
  for (const profile of config.config_server_profiles ?? []) {
    profile.name = profile.name.trim()
    profile.url = profile.url.trim()
    if (!profile.url || /\s/.test(profile.url))
      throw new Error('config-server.invalid_address')
    if (ids.has(profile.id) || urls.has(profile.url))
      throw new Error('config-server.duplicate_address')
    ids.add(profile.id)
    urls.add(profile.url)
  }
  const selected = config.config_server_profiles?.find(profile => profile.id === config.selected_config_server_id)
  if (config.selected_config_server_id && !selected)
    throw new Error('config-server.missing_selection')
  config.config_server_url = selected?.url
}
