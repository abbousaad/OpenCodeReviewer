---
name: owasp-api-review
description: Review API code for the OWASP API Security Top 10 risks.
---

# OWASP API review

Use the [OWASP API Security Top 10 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/)
when the review unit handles an API or consumes one.

- **API1:2023 Object authorization (BOLA/IDOR).** For requests with a record ID, follow the authenticated identity from the route through the service to the query or authorization check. Check that a caller cannot read or modify another owner's record.
- **API2:2023 Authentication.** Check token verification, expiry and revocation, credential recovery, and defenses against brute-force attempts.
- **API3:2023 Property authorization.** Inspect request binding and response fields. Check that callers cannot write protected fields or read fields outside their privileges.
- **API4:2023 Resource limits.** Check bounds on body size, pagination, query complexity, concurrency, timeouts, and operations that trigger paid services.
- **API5:2023 Function authorization.** Check role and permission enforcement for admin routes, privileged actions, and alternate methods.
- **API6:2023 Business-flow abuse.** Check quotas, replay protection, and automation controls for operations such as purchasing, signup, and reservation.
- **API7:2023 Server-side request forgery.** Trace user-controlled destinations. Check restrictions on schemes, redirects, and private network targets.
- **API8:2023 Configuration.** Check cross-origin policy, transport protection, debug output, enabled methods, and sensitive error details.
- **API9:2023 API inventory.** Check evidence of exposed legacy versions, debug routes, and undocumented endpoints that bypass current controls.
- **API10:2023 Upstream API trust.** Check validation of third-party responses, credential forwarding, redirect handling, and upstream timeouts.

For a suspected IDOR, describe the concrete cross-user request and the
authorization or query behavior that allows it. If the available code shows
only a route that delegates to an unseen helper, mark ownership unverified in
the summary. Prefer the specific API ID for a finding that also fits the web
list. Use one finding per root cause.
