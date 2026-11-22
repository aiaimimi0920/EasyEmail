// Isolate the actual legacy D1 cleanup from Telegram, translations and unrelated utility imports.
export function legacyCleanupPlugin() {
  return { name: "synthetic-legacy-cleanup-boundaries", setup(build) {
    build.onResolve({ filter: /^\.\/(utils|i18n|telegram_api\/common)$/ }, (args) => {
      if (!args.importer.replaceAll("\\", "/").endsWith("/worker/src/common-cleanup.ts")) return;
      return { path: args.path, namespace: "synthetic-legacy-boundary" };
    });
    build.onLoad({ filter: /.*/, namespace: "synthetic-legacy-boundary" }, ({ path }) => ({ loader: "js", contents:
      path === "./utils" ? "export const getBooleanValue = (value) => value === true || value === 'true';"
        : path === "./i18n" ? `export default { getMessagesbyContext: () => ({ UserDeleteEmailDisabledMsg: 'delete disabled',
          RequiredFieldMsg: 'identity required', AddressNotFoundMsg: 'address not found', OperationFailedMsg: 'operation failed' }) };`
          : `export async function unbindTelegramByAddress(c, address) {
            await c.env.DB.prepare('UPDATE fixture_external_counter SET n=n+1').run();
            const mode = (await c.env.DB.prepare('SELECT mode FROM fixture_auth_control').first()).mode;
            if (mode === 'replace-before-cleanup') {
              await c.env.DB.prepare('DELETE FROM address WHERE name=?').bind(address).run();
              const row = await c.env.DB.prepare('INSERT INTO address(name) VALUES(?) RETURNING id').bind(address).first();
              await c.env.DB.prepare('INSERT INTO users_address(address_id,user_id) VALUES(?,456)').bind(row.id).run();
            }
            if (mode === 'fail-before-cleanup') throw Error('synthetic external failure');
          }`
    }));
  } };
}
