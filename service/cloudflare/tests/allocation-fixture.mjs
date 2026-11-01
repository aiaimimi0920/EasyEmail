export const automatic = (h, cookie, key = crypto.randomUUID(), extra = {}) => h.request("/api/v1/mailboxes", {
  cookie, method: "POST", headers: { "idempotency-key": key }, body: { selection: "automatic" }, ...extra,
});

export const allocationRuntime = (h, id = "self") => h.db.prepare("SELECT * FROM provider_allocation_state WHERE provider_id=?").bind(id).first();
export const creationCalls = (f) => f.calls.filter((call) => call.path === "/cf/admin/new_address");
