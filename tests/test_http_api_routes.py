from __future__ import annotations

import re
from collections import Counter

from tests.http_api_contract_support import (
    DYNAMIC_ROUTE_METHODS,
    STATIC_ROUTE_DISPATCH,
    HttpApiContractTestCase,
    extract_dynamic_routes,
    extract_static_routes,
    resolve_local_ref,
)


class HttpApiRouteContractTests(HttpApiContractTestCase):
    def test_openapi_covers_every_service_route(self) -> None:
        static_routes = set(extract_static_routes(self.server_text).values())
        dynamic_routes = set(extract_dynamic_routes(self.server_text).values())
        documented_paths = set(self.openapi["paths"])

        self.assertEqual(documented_paths, static_routes | dynamic_routes)

    def test_route_constants_are_unique_and_completely_dispatched(self) -> None:
        static_routes = extract_static_routes(self.server_text)
        dynamic_routes = extract_dynamic_routes(self.server_text)
        all_paths = [*static_routes.values(), *dynamic_routes.values()]

        duplicate_paths = sorted(
            path for path, count in Counter(all_paths).items() if count > 1
        )
        self.assertEqual(duplicate_paths, [])

        static_dispatches = STATIC_ROUTE_DISPATCH.findall(self.route_text)
        static_references = Counter(name for _, name in static_dispatches)
        self.assertEqual(set(static_references), set(static_routes))
        self.assertEqual(
            len(static_dispatches), len(set(static_dispatches)), "duplicate static dispatch"
        )

        self.assertEqual(set(dynamic_routes), set(DYNAMIC_ROUTE_METHODS))
        for name, methods in DYNAMIC_ROUTE_METHODS.items():
            for handler_name in methods.values():
                self.assertEqual(
                    self.route_text.count(f"handler.{handler_name}("),
                    1,
                    f"{name}: {handler_name}",
                )

    def test_openapi_methods_match_service_route_implementations(self) -> None:
        routes = extract_static_routes(self.server_text)
        dynamic_routes = extract_dynamic_routes(self.server_text)
        route_methods: dict[str, set[str]] = {}
        for method, name in STATIC_ROUTE_DISPATCH.findall(self.route_text):
            route_methods.setdefault(routes[name], set()).add(method.lower())
        for name, methods in DYNAMIC_ROUTE_METHODS.items():
            route_methods.setdefault(dynamic_routes[name], set()).update(methods)

        self.assertEqual(set(route_methods), set(self.openapi["paths"]))
        for path, methods in route_methods.items():
            documented_methods = set(self.openapi["paths"][path]) & {
                "get",
                "post",
                "put",
                "patch",
                "delete",
            }
            self.assertEqual(documented_methods, methods, path)

    def test_generic_commands_endpoint_is_not_exposed(self) -> None:
        for path in self.openapi["paths"]:
            self.assertNotIn("/commands", path)
        self.assertNotRegex(
            self.http_source_text,
            r'["`][^"`\n]*/commands(?:/|\{|["`])',
        )

    def test_openapi_operations_and_local_references_are_well_formed(self) -> None:
        operation_ids: set[str] = set()

        def visit(value: object) -> None:
            if isinstance(value, list):
                for item in value:
                    visit(item)
                return
            if not isinstance(value, dict):
                return
            ref = value.get("$ref")
            if isinstance(ref, str):
                resolve_local_ref(self.openapi, ref)
            for item in value.values():
                visit(item)

        visit(self.openapi)

        for path, path_item in self.openapi["paths"].items():
            placeholders = set(re.findall(r"\{([^}]+)\}", path))
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue

                operation_id = operation.get("operationId")
                self.assertIsInstance(operation_id, str, f"{method} {path}")
                self.assertNotIn(
                    operation_id,
                    operation_ids,
                    f"duplicate operationId: {operation_id}",
                )
                operation_ids.add(operation_id)
                self.assertIn(
                    "200", operation.get("responses", {}), f"{method} {path}"
                )

                parameters = []
                for parameter in operation.get("parameters", []):
                    if "$ref" in parameter:
                        parameter = resolve_local_ref(self.openapi, parameter["$ref"])
                    parameters.append(parameter)
                documented_path_parameters = {
                    parameter["name"]
                    for parameter in parameters
                    if isinstance(parameter, dict)
                    and parameter.get("in") == "path"
                    and parameter.get("required") is True
                }
                self.assertEqual(
                    documented_path_parameters, placeholders, f"{method} {path}"
                )

    def test_openapi_is_the_authenticated_direct_http_contract(self) -> None:
        self.assertEqual(self.openapi["openapi"], "3.1.0")
        self.assertEqual(
            self.openapi["servers"][0]["url"], "http://127.0.0.1:18081"
        )
        self.assertEqual(self.openapi["security"], [{"bearerAuth": []}])
        bearer = self.openapi["components"]["securitySchemes"]["bearerAuth"]
        self.assertEqual(bearer["type"], "http")
        self.assertEqual(bearer["scheme"], "bearer")
        self.assertIn(
            "published client SDK is not required",
            self.openapi["info"]["description"],
        )
