/**
 * Project Forge · Review Mode — placeholder plugin.
 *
 * The review preset does NOT load the project-forge plugin: a standalone review session is
 * read-mostly and carries no steward state, and a forked child inherits the real plugin from
 * its project-forge parent (agent-preset-registry `composeFrom`). Joining a preset twice
 * throws, so this preset must not declare the plugin. This file exists only so the bundle
 * has a valid plugin entry; it registers nothing and is inert.
 */
export const name = 'project-forge-review-placeholder'
export const inject = []

export function apply() {
  /* inert — see the bundle's cordis.patch.yml for why the real plugin is absent here */
}
