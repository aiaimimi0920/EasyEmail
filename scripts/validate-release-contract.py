from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "release-contract.json"
PRODUCT_CONTRACT_PATH = ROOT / "product-contract.json"
DOC_PATH = ROOT / "docs" / "release-contract.md"


def load_contract() -> dict[str, Any]:
    if not CONTRACT_PATH.exists():
        raise AssertionError(f"missing contract file: {CONTRACT_PATH}")
    payload = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1:
        raise AssertionError("release-contract.json schemaVersion must be 1")
    return payload


def require_file(relative_path: str) -> Path:
    path = ROOT / relative_path
    if not path.exists():
        raise AssertionError(f"missing required file: {relative_path}")
    return path


def require_text(path: Path, needle: str) -> None:
    text = path.read_text(encoding="utf-8")
    if needle not in text:
        raise AssertionError(f"{path.relative_to(ROOT)} must contain {needle!r}")


def require_regex(path: Path, pattern: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if not re.search(pattern, text, flags=re.MULTILINE):
        raise AssertionError(f"{path.relative_to(ROOT)} missing {label}: {pattern}")


def validate_workflow(workflow: dict[str, Any]) -> None:
    relative = str(workflow["path"])
    path = require_file(relative)
    text = path.read_text(encoding="utf-8")
    if "workflow_dispatch:" not in text:
        raise AssertionError(f"{relative} must expose workflow_dispatch")
    if "workflow_call:" not in text:
        raise AssertionError(f"{relative} must expose workflow_call")

    for input_name in workflow.get("releaseTagInputs", []):
        require_regex(path, rf"^\s+{re.escape(input_name)}:\s*$", f"workflow_dispatch input {input_name}")

    for output_name in workflow.get("releaseTagOutputs", []):
        if f'echo "{output_name}=' not in text and f"echo '{output_name}=" not in text:
            raise AssertionError(f"{relative} must write release metadata output {output_name}")

    for artifact_name in workflow.get("artifacts", []):
        require_regex(path, rf"^\s+name:\s*{re.escape(artifact_name)}\s*$", f"artifact {artifact_name}")

    if workflow.get("requiresGhcr"):
        if "docker/build-push-action" not in text and "docker build" not in text and "ghcr.io" not in text:
            raise AssertionError(f"{relative} must contain a GHCR/docker image publication path")

    if workflow.get("requiresR2"):
        if "R2_CONFIG" not in text and "r2-config" not in text.lower():
            raise AssertionError(f"{relative} must contain R2 config distribution wiring")

    if workflow.get("requiresImportCode"):
        if "import-code" not in text or "encrypt" not in text:
            raise AssertionError(f"{relative} must generate an encrypted import-code artifact")

    if workflow.get("requiresCloudflareDeploy"):
        if "scripts/deploy-cloudflare-email.ps1" not in text:
            raise AssertionError(f"{relative} must invoke the Cloudflare email deploy entrypoint")

    if workflow.get("requiresRuntimeReadback"):
        if "/health_check" not in text or "cloudflare-email-runtime-readback" not in text:
            raise AssertionError(f"{relative} must verify and publish Cloudflare runtime readback")

    if workflow.get("requiresDistributionBuilder"):
        require_file("scripts/build-distribution.py")
        if "scripts/build-distribution.py" not in text or "--verify-only" not in text:
            raise AssertionError(f"{relative} must build and re-verify the client/userscript distribution")

    if workflow.get("requiresReusableValidation"):
        if "uses: ./.github/workflows/reusable-validate.yml" not in text:
            raise AssertionError(f"{relative} must call the reusable validation workflow")

    if workflow.get("requiresAttestation"):
        if "actions/attest-build-provenance" not in text:
            raise AssertionError(f"{relative} must attest its published artifacts")

    if workflow.get("requiresGitHubRelease"):
        if "gh release create" not in text or "gh release upload" not in text:
            raise AssertionError(f"{relative} must create/update a GitHub Release and upload assets")

    if workflow.get("forbidsProductionSecrets") and "secrets." in text:
        raise AssertionError(f"{relative} must not read repository or environment secrets")

    environment = str(workflow.get("environment") or "").strip()
    if environment and environment not in text:
        raise AssertionError(f"{relative} must use environment {environment}")


def validate_workflows(contract: dict[str, Any]) -> None:
    workflows = contract.get("workflows", [])
    if not isinstance(workflows, list) or not workflows:
        raise AssertionError("at least one release workflow is required")

    components: set[str] = set()
    paths: set[str] = set()
    for workflow in workflows:
        component = str(workflow.get("component") or "").strip()
        path = str(workflow.get("path") or "").strip()
        if not component or component in components:
            raise AssertionError(f"workflow components must be non-empty and unique: {component!r}")
        if not path or path in paths:
            raise AssertionError(f"workflow paths must be non-empty and unique: {path!r}")
        components.add(component)
        paths.add(path)
        validate_workflow(workflow)


def validate_coordinator(contract: dict[str, Any]) -> None:
    coordinator = contract.get("coordinator")
    if not isinstance(coordinator, dict):
        raise AssertionError("coordinator is required")

    relative = str(coordinator.get("path") or "").strip()
    path = require_file(relative)
    text = path.read_text(encoding="utf-8")
    require_text(path, "uses: ./.github/workflows/reusable-validate.yml")
    require_text(path, "group: release-${{ inputs.release_tag || github.ref_name }}")
    require_text(path, "cancel-in-progress: false")

    targets = coordinator.get("targets", [])
    if targets != ["all", "service-base", "cloudflare-email", "client-userscript"]:
        raise AssertionError("coordinator targets must declare the supported release surfaces")
    for target in targets:
        require_text(path, f"- {target}")

    for pattern in coordinator.get("publicTagPatterns", []):
        require_text(path, f'- "{pattern}"')

    workflow_paths = {
        str(workflow["component"]): str(workflow["path"])
        for workflow in contract.get("workflows", [])
    }
    for component in coordinator.get("serialOrder", []):
        component_path = workflow_paths.get(str(component))
        if not component_path:
            raise AssertionError(f"coordinator serialOrder references unknown component: {component}")
        require_text(path, f"uses: ./{component_path}")

    if coordinator.get("requiresReusableValidation") and "skip_preflight: true" not in text:
        raise AssertionError("coordinator must run one preflight and explicitly bypass duplicate component preflights")


def validate_required_files(contract: dict[str, Any]) -> None:
    for relative in contract.get("requiredFiles", []):
        require_file(str(relative))


def validate_product_contract(contract: dict[str, Any]) -> None:
    relative = str(contract.get("productContract") or "").strip()
    if relative != "product-contract.json":
        raise AssertionError("release contract must reference product-contract.json")
    require_file(relative)

    product = json.loads(PRODUCT_CONTRACT_PATH.read_text(encoding="utf-8"))
    if product.get("schemaVersion") != 1:
        raise AssertionError("product-contract.json schemaVersion must be 1")

    core = product.get("core")
    if not isinstance(core, dict) or core.get("id") != "service-base" or core.get("publicInterface") != "http":
        raise AssertionError("product contract must define service-base as the HTTP core")

    products = product.get("products")
    if not isinstance(products, dict):
        raise AssertionError("product contract products are required")

    standalone = products.get("standaloneServer")
    if not isinstance(standalone, dict) or standalone.get("requiresPublishedSdk") is not False:
        raise AssertionError("standalone server callers must not require a published SDK")

    bundled_ui = products.get("bundledUi")
    if not isinstance(bundled_ui, dict):
        raise AssertionError("bundled UI product contract is required")
    expected_ui_contract = {
        "core": "service-base",
        "implementationStatus": "bundled-core-hosted-http-migration-in-progress",
        "bundlesCore": True,
        "startsCoreAutomatically": True,
        "transport": "loopback-http",
        "requiresDocker": False,
        "requiresExternalNode": False,
        "lifecycleOwner": "ui-host",
    }
    for key, expected in expected_ui_contract.items():
        if bundled_ui.get(key) != expected:
            raise AssertionError(f"bundled UI contract {key} must be {expected!r}")

    userscript = products.get("userscript")
    if not isinstance(userscript, dict):
        raise AssertionError("Userscript product contract is required")
    if userscript.get("implementation") != "independent-direct-provider-runtime":
        raise AssertionError("Userscript must remain an independent direct-provider runtime")
    for key in ("dependsOnServiceBase", "usesServiceBaseHttpApi", "sharesBusinessImplementationWithServiceBase"):
        if userscript.get(key) is not False:
            raise AssertionError(f"Userscript product contract {key} must be false")

    client = product.get("compatibility", {}).get("typescriptClient")
    if not isinstance(client, dict) or client.get("required") is not False:
        raise AssertionError("TypeScript client must remain optional")
    if client.get("authoritativeApiContract") is not False:
        raise AssertionError("TypeScript client must not own the authoritative API contract")

    require_file(str(core.get("apiSpecification") or ""))
    require_file(str(bundled_ui.get("contractDocument") or ""))


def validate_deploy(contract: dict[str, Any]) -> None:
    deploy = contract.get("localDeploy", {})
    entrypoint = str(deploy.get("entrypoint") or "").strip()
    if entrypoint:
        require_file(entrypoint)
    if bool(deploy.get("zeroFolder")) and not entrypoint:
        raise AssertionError("zeroFolder local deploys must declare an entrypoint")


def validate_doc(contract: dict[str, Any]) -> None:
    if not DOC_PATH.exists():
        raise AssertionError(f"missing release contract document: {DOC_PATH.relative_to(ROOT)}")
    require_text(DOC_PATH, "# Release Contract")
    require_text(DOC_PATH, str(contract["project"]))
    require_text(DOC_PATH, str(contract["releaseClass"]))


def main() -> int:
    contract = load_contract()
    if not contract.get("project"):
        raise AssertionError("project is required")
    if not contract.get("releaseClass"):
        raise AssertionError("releaseClass is required")
    validate_workflows(contract)
    validate_coordinator(contract)
    validate_required_files(contract)
    validate_product_contract(contract)
    validate_deploy(contract)
    validate_doc(contract)
    print(f"release contract ok: {contract['project']} ({contract['releaseClass']})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"release contract failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
