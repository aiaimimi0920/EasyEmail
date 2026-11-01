export const M2U_PROXY_HELPER_SCRIPT = `
import json
import ipaddress
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

base_url = str(sys.argv[1]).strip()
method = str(sys.argv[2]).strip().upper() or "GET"
path = str(sys.argv[3]).strip()
headers = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].strip() else {}
body = json.loads(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].strip() else None
proxy_cfg = json.loads(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6].strip() else {}

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def read_json_response(opener, req):
    with opener.open(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))

def build_management_opener(api_base):
    parsed = urllib.parse.urlsplit(str(api_base or "").strip())
    host = str(parsed.hostname or "").strip()
    should_bypass_proxy = host in ("127.0.0.1", "localhost", "::1", "0.0.0.0", "easy-proxy-service")
    if not should_bypass_proxy and host:
        try:
            ip = ipaddress.ip_address(host)
            should_bypass_proxy = bool(ip.is_loopback or ip.is_private or ip.is_link_local)
        except ValueError:
            should_bypass_proxy = False
    if should_bypass_proxy:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirectHandler())
    return urllib.request.build_opener(NoRedirectHandler())

def api_request(method_name, api_base, api_key, path_value):
    effective_base = str(api_base or "").rstrip("/")
    opener = build_management_opener(effective_base)
    headers_value = {"Content-Type": "application/json"}
    if str(api_key or "").strip():
        headers_value["Authorization"] = "Bearer " + str(api_key).strip()
    request = urllib.request.Request(
        effective_base + path_value,
        headers=headers_value,
        method=method_name,
    )
    return read_json_response(opener, request)

def resolve_runtime_host(api_base, runtime_host):
    value = str(runtime_host or "").strip()
    if value:
        return value
    parsed = urllib.parse.urlsplit(str(api_base or "").strip())
    host = str(parsed.hostname or "127.0.0.1").strip()
    if host in ("", "0.0.0.0", "::", "[::]", "localhost"):
        return "127.0.0.1"
    return host

def build_proxy_url(protocol, host, port, username, password):
    scheme = str(protocol or "http").strip() or "http"
    if username:
        quoted_user = urllib.parse.quote(str(username), safe="")
        quoted_password = urllib.parse.quote(str(password or ""), safe="")
        return f"{scheme}://{quoted_user}:{quoted_password}@{host}:{port}"
    return f"{scheme}://{host}:{port}"

def checkout_random_node_proxy(cfg):
    effective_base = str(cfg.get("easyProxyBaseUrl") or "").strip()
    if not effective_base:
        raise RuntimeError("easyProxyBaseUrl missing")
    api_key = str(cfg.get("easyProxyApiKey") or "").strip()
    settings = api_request("GET", effective_base, api_key, "/api/settings")
    nodes_payload = api_request("GET", effective_base, api_key, "/api/nodes?only_available=1&prefer_available=1")
    nodes = nodes_payload.get("nodes") or []
    if not isinstance(nodes, list) or not nodes:
        raise RuntimeError("EasyProxy random node checkout found no available nodes")

    excluded = {
        str(item).strip().lower()
        for item in (cfg.get("excludedProxyUrls") or [])
        if str(item).strip()
    }
    rng = secrets.SystemRandom()
    candidates = list(nodes)
    rng.shuffle(candidates)

    protocol = str(settings.get("multi_port_protocol") or settings.get("listener_protocol") or "http").strip() or "http"
    username = str(settings.get("multi_port_username") or settings.get("listener_username") or "").strip()
    password = str(settings.get("multi_port_password") or settings.get("listener_password") or "").strip()
    host = resolve_runtime_host(effective_base, cfg.get("easyProxyRuntimeHost"))

    for node in candidates:
        if not isinstance(node, dict):
            continue
        try:
          port = int(node.get("port") or 0)
        except Exception:
          port = 0
        if port <= 0:
            continue
        proxy_url = build_proxy_url(protocol, host, port, username, password)
        if proxy_url.lower() in excluded:
            continue
        return {
            "proxyUrl": proxy_url,
            "metadata": {
                "selectedNodeTag": str(node.get("tag") or "").strip(),
                "selectedNodeName": str(node.get("name") or "").strip(),
                "selectedNodePort": str(port),
                "selectedNodeMode": "dedicated-node",
                "selectedNodeAvailability": str(bool(node.get("available"))).lower(),
                "selectedNodeAvailabilityScore": str(node.get("availability_score") or ""),
                "selectedNodeRegion": str(node.get("region") or "").strip(),
                "selectedNodeCountry": str(node.get("country") or "").strip(),
                "selectedNodeProtocolFamily": str(node.get("protocol_family") or "").strip(),
                "selectedNodeDomainFamily": str(node.get("domain_family") or "").strip(),
                "selectedNodeSourceRef": str(node.get("source_ref") or "").strip(),
            },
        }

    raise RuntimeError("EasyProxy random node checkout exhausted available nodes")

def main():
    proxy_url = str(proxy_cfg.get("upstreamProxyUrl") or "").strip()
    proxy_metadata = {}
    if not proxy_url:
        selected = checkout_random_node_proxy(proxy_cfg)
        proxy_url = str(selected.get("proxyUrl") or "").strip()
        proxy_metadata = selected.get("metadata") or {}
    if not proxy_url:
        raise RuntimeError("proxyUrl missing")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({
        "http": proxy_url,
        "https": proxy_url,
    }), NoRedirectHandler())
    request_body = None
    if body is not None:
        request_body = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=request_body,
        headers=headers,
        method=method,
    )
    try:
        with opener.open(request, timeout=35) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else {}
            except Exception:
                parsed = raw
            print(json.dumps({
                "status": int(getattr(resp, "status", 200) or 200),
                "body": parsed,
                "proxyUrl": proxy_url,
                "proxyMetadata": proxy_metadata,
            }))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = raw
        print(json.dumps({
            "status": int(exc.code),
            "body": parsed,
            "proxyUrl": proxy_url,
            "proxyMetadata": proxy_metadata,
        }))
    except Exception as exc:
        print(json.dumps({
            "proxyUrl": proxy_url,
            "proxyMetadata": proxy_metadata,
            "helperError": str(exc),
        }))

main()
`.trim();
