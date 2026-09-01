import type { InvokeCommand } from "./invokeCommand";
import { createDesktopCoreClient } from "./desktopCoreClient.ts";
import {
  createEasyEmailHttpClient,
  type EasyEmailCatalogResponse,
} from "./easyEmailHttpClient.ts";

export function createBundledCoreClient(
  invokeCommand: InvokeCommand,
  fetchRequest: typeof fetch = globalThis.fetch,
) {
  const desktopCoreClient = createDesktopCoreClient(invokeCommand);
  let httpClientPromise:
    | Promise<ReturnType<typeof createEasyEmailHttpClient>>
    | undefined;

  function getHttpClient() {
    if (!httpClientPromise) {
      httpClientPromise = desktopCoreClient
        .getRuntime()
        .then((runtime) =>
          createEasyEmailHttpClient({
            baseUrl: runtime.base_url,
            bearerToken: runtime.api_token,
            fetch: fetchRequest,
          }),
        )
        .catch((error: unknown) => {
          httpClientPromise = undefined;
          throw error;
        });
    }
    return httpClientPromise;
  }

  return {
    async getCatalog<TCatalog = unknown>(): Promise<EasyEmailCatalogResponse<TCatalog>> {
      return (await getHttpClient()).getCatalog<TCatalog>();
    },
  };
}
