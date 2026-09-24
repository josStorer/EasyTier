import { describe, expect, it } from 'vitest'
import { normalizeConfigServerProfiles, validateConfigServerProfiles } from './config_server_profiles'

describe('saved configuration servers', () => {
  it('migrates the legacy URL and preserves unrelated mode options', () => {
    const original = { mode: 'normal', config_server_url: 'udp://example.test:22020/admin', rpc_portal: 'localhost' }
    const migrated = normalizeConfigServerProfiles(original)
    expect(migrated.config_server_profiles).toHaveLength(1)
    expect(migrated.config_server_url).toBe(original.config_server_url)
    expect(migrated.rpc_portal).toBe('localhost')
    expect(normalizeConfigServerProfiles(migrated)).toEqual(migrated)
    expect(original).not.toHaveProperty('config_server_profiles')
  })

  it('selects one saved server and can disable management without deleting profiles', () => {
    const config = normalizeConfigServerProfiles({ config_server_url: 'alice' })
    config.config_server_profiles!.push({ id: 'B', name: ' Work ', url: ' bob ' })
    config.selected_config_server_id = 'B'
    validateConfigServerProfiles(config)
    expect(config.config_server_url).toBe('bob')
    expect(config.config_server_profiles![1].name).toBe('Work')
    config.selected_config_server_id = undefined
    validateConfigServerProfiles(config)
    expect(normalizeConfigServerProfiles(config).config_server_url).toBeUndefined()
    expect(config.config_server_profiles).toHaveLength(2)
  })

  it('rejects duplicate, empty, and missing selections', () => {
    const config = normalizeConfigServerProfiles({ config_server_url: 'alice' })
    config.config_server_profiles!.push({ id: 'B', name: '', url: ' alice ' })
    expect(() => validateConfigServerProfiles(config)).toThrow('duplicate_address')
    config.config_server_profiles![1].url = ''
    expect(() => validateConfigServerProfiles(config)).toThrow('invalid_address')
    config.config_server_profiles!.pop()
    config.selected_config_server_id = 'missing'
    expect(() => validateConfigServerProfiles(config)).toThrow('missing_selection')
  })
})
