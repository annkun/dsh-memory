/**
 * dsh-memory client: registers a "Memory" tab inside the Plugins settings
 * section. Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; the only externals are the loader module table's react
 * entries.
 */
import { createElement as h } from 'react'

interface ClientSlotContext {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

export const name = '@fooxe/dsh-memory'
export const inject = ['slots']

export function apply(ctx: ClientSlotContext): void {
  // The Plugins settings section's tab slot: "one page inside the Plugins
  // settings section", rendered as a tab beside the host's own. A host that
  // does not declare this slot never runs this registration (clean downgrade).
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-memory',
    order: 70,
    label: () => 'Memory',
    locale: 'dsh-memory',
  }, () => h('div', { style: { padding: '16px' } },
    h('h2', null, 'Memory'),
    h('p', null, 'dsh-memory panel — hello from the client bundle. (MVP list lands here.)'),
  )))
}
