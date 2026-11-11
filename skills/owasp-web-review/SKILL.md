---
name: owasp-web-review
description: Review code for the OWASP Top 10 web application risks.
---

# OWASP web review

Use the [OWASP Top 10 2025](https://top10.owasp.org/2025/) to check the security
risks relevant to the code in this review unit.

- **A01:2025 Access control.** Follow caller identity, role, tenant, and ownership to the protected action or data query. Check alternate routes and methods.
- **A02:2025 Configuration.** Check exposed debug and admin interfaces, permissive CORS, insecure defaults, and runtime configuration that exposes data.
- **A03:2025 Supply chain.** Inspect dependency sources and version pins, CI privileges, and build or release inputs. Cite the actual dependency or build path involved.
- **A04:2025 Cryptography.** Check secret storage, password hashing, token randomness, key handling, and encryption of sensitive data.
- **A05:2025 Injection.** Trace untrusted data to database queries, shells, templates, browsers, and other interpreters. Check parameterization or context-appropriate encoding.
- **A06:2025 Design.** Use documented business rules to check trust boundaries, allowed transitions, replay, and abuse of sensitive workflows.
- **A07:2025 Authentication.** Check credential handling, session expiry and revocation, recovery, and protections against repeated login attempts.
- **A08:2025 Integrity.** Check trust in signed artifacts, webhooks, serialized data, and updates. Verify signatures or checksums where the design relies on them.
- **A09:2025 Logging and alerting.** Check whether security events are recorded and can be acted on. Keep credentials and sensitive data out of logs.
- **A10:2025 Exception handling.** Check whether errors, timeouts, malformed input, or partial failures bypass controls, leak details, or leave unsafe state.

For each security finding, put the most specific applicable OWASP ID at the
start of its message and use the `security` category. Cite a file and line from
the review unit. Explain the reachable input, failed control, and impact.
Apply the review scope when selecting the cited line. In CI, the finding must
be tied to a changed line.

If a relevant control may be implemented in code outside this unit, name the
missing evidence in the summary and mark the check unverified. Keep coverage
gaps and speculative issues out of the findings array. Use a single finding
when the same root cause fits both OWASP lists.
