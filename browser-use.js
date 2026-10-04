/**
 * Bundle-local entry point for the browser-use seam row.
 *
 * The `browser-use` row in cordis.patch.yml must name a specifier the PROFILE
 * can import. The Loader imports a row's `name` relative to the profile's
 * config file, so a bare `@deepseek-ai/dsh-browser-use` only resolves when that
 * package is a dependency of the profile itself. It is not: this bundle carries
 * it as its own dependency, so the bare specifier failed with
 * ERR_MODULE_NOT_FOUND, the row never provided `browserUse`, and
 * `browserbase-provider` stayed PENDING forever.
 *
 * Inserted relative names are anchored beside their patch file
 * (dsh-app-boot `anchorInsertedPluginNames`), so this file becomes a `file://`
 * URL inside the bundle directory. That makes the row resolvable, and the
 * re-export below resolves from here — where the seam package does exist.
 *
 * The seam stays defined in exactly one place: this adds no copy, no fork, and
 * no second service instance.
 */
export { default } from '@deepseek-ai/dsh-browser-use';
