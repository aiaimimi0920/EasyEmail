import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Keep production address/domain validation, INSERT and JWT signing; isolate unrelated configuration/UI dependencies.
export function addressCreatePlugin() {
  return { name: "local-production-address-creation", setup(build) {
    build.onResolve({ filter: /^hono\/utils\/jwt$/ }, () => ({ path: require.resolve("hono/utils/jwt") }));
    build.onResolve({ filter: /^\.\/(utils|i18n|common-access)$/ }, (args) => {
      if (!/\/worker\/src\/common-(address|domain)\.ts$/.test(args.importer.replaceAll("\\", "/"))) return;
      return { path: args.path, namespace: "synthetic-address-configuration" };
    });
    build.onLoad({ filter: /.*/, namespace: "synthetic-address-configuration" }, ({ path }) => ({ loader: "js", contents:
      path === "./utils" ? `export const getBooleanValue = (value) => value === true || value === 'true';
        export const getStringValue = (value) => typeof value === 'string' ? value : '';
        export const getStringArray = (value) => value ? JSON.parse(value) : [];
        export const getDomains = (c) => getStringArray(c.env.DOMAINS);
        export const getIntValue = (value, fallback) => value == null ? fallback : Number(value);
        export const getJsonSetting = async () => null;
        export const getJsonObjectValue = () => null;
        export const getRandomSubdomainDomains = () => [];
        export const hashPassword = async () => { throw Error('Address password fixture is not enabled'); };`
        : path === "./common-access" ? "export const getAllowDomains = async (c) => JSON.parse(c.env.DOMAINS);"
          : `export default { getMessagesbyContext: () => ({ RequiredFieldMsg: 'required', NameTooShortMsg: 'too short',
            NameTooLongMsg: 'too long', InvalidDomainMsg: 'invalid domain', AddressAlreadyExistsMsg: 'exists',
            FailedCreateAddressMsg: 'create failed', RandomSubdomainNotAllowedMsg: 'subdomain disabled' }) };`
    }));
  } };
}
