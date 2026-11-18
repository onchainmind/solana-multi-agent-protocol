# OWASP ZAP API Security Testing for Cypher Agent

This directory provides the official [OWASP ZAP (Zed Attack Proxy)](https://www.zaproxy.org/) automated baseline security scan configuration for the Cypher autonomous agent.

---

## 1. Attack Surface Analysis

The Cypher agent operates primarily as an off-chain daemon interacting with Solana RPC nodes and Jupiter REST APIs. To enable orchestration in enterprise container environments (Kubernetes, AWS ECS, Nomad), the agent provides an optional minimal HTTP health check service (`agent/src/health.ts`):

- **Default Port**: Disabled by default; activated when `AGENT_HEALTH_PORT` is specified (e.g. `AGENT_HEALTH_PORT=8080`).
- **Bound Host**: `127.0.0.1` (loopback only by default).
- **Exposed Endpoints**:
  - `GET /healthz` — Returns agent operational status, process uptime, target cluster, and last crank timestamp.
- **Defensive Hardening**:
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `Cache-Control: no-store, no-cache, must-revalidate`
  - Server headers stripped to prevent information disclosure.
  - Rejection of all non-GET methods (`405 Method Not Allowed`).

---

## 2. Running OWASP ZAP Baseline Scan Locally (Docker)

To run a scan against the agent's healthcheck endpoint:

```bash
# 1. Start the agent with health endpoint active
export AGENT_HEALTH_PORT=8080
npm run start:agent &

# 2. Execute OWASP ZAP Baseline Scan via Docker
docker run -v $(pwd)/.zap:/zap/wrk/:rw -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t http://host.docker.internal:8080/healthz \
  -c zap-baseline.conf \
  -r zap-report.html
```

---

## 3. GitHub Actions CI Integration

OWASP ZAP scans can be run in CI using the official ZAP action:

```yaml
- name: ZAP Scan
  uses: zaproxy/action-baseline@v0.12.0
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    docker_name: 'ghcr.io/zaproxy/zaproxy:stable'
    target: 'http://localhost:8080/healthz'
    rules_file_name: '.zap/zap-baseline.conf'
    cmd_options: '-a'
```

