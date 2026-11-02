# Yahoo! Security Messenger - Security Rules & Kiro Agent Specifications

## Overview

This document defines the security policies, agent behaviors, and compliance rules for the Yahoo! Security Messenger Kiro AI agent suite. Three autonomous agents enforce security, audit activity, and manage threat response.

---

## Agent Specifications

### 1. auditor_bot

**Purpose**: Continuous compliance auditing and policy enforcement  
**Trigger**: Scheduled (5-minute intervals) + event-based  
**Autonomy Level**: Full (can log incidents, generate reports, recommend policy updates)

#### Responsibilities
- Audit all user interactions against security policies
- Verify E2EE key rotation compliance
- Check message authentication tags for tampering
- Monitor user permission changes and access grants
- Generate compliance reports for regulatory requirements
- Flag policy violations for human review

#### Rules & Triggers

| Rule | Condition | Action | Severity |
|------|-----------|--------|----------|
| **Unencrypted Message Detection** | Message sent without E2EE wrapper | Log violation, notify user, drop message | Critical |
| **Key Rotation Overdue** | User hasn't rotated keys in 30 days | Alert user, request immediate rotation | High |
| **Unauthorized Access Attempt** | User accesses others' archived messages | Log incident, revoke session | Critical |
| **Policy Violation** | Message content matches restricted patterns | Quarantine message, audit log entry | Medium |
| **Compliance Report Generation** | Weekly schedule (Mondays 00:00 UTC) | Generate audit summary, export to database | Low |
| **User Permission Escalation** | User granted admin role | Record change, require second factor | High |

#### Output Artifacts
- Security audit logs (stored in `security_logs` table)
- Weekly compliance reports (JSON format)
- Policy violation alerts
- Key rotation reminders

---

### 2. sentinel_bot

**Purpose**: Real-time threat detection and anomaly analysis  
**Trigger**: Event-driven (message arrival, connection state change, behavioral pattern)  
**Autonomy Level**: Full (can block connections, flag accounts, escalate to BUZZ!)

#### Responsibilities
- Detect anomalous messaging patterns in real-time
- Identify coordinated attack attempts (multiple accounts, rapid fire messages)
- Monitor connection patterns and geographic inconsistencies
- Analyze message metadata for timing/frequency anomalies
- Escalate critical threats to buzz_guard for BUZZ! activation
- Maintain threat intelligence database

#### Detection Rules

| Threat Pattern | Detection Method | Action | Alert Level |
|---|---|---|---|
| **Brute Force Auth** | >5 failed logins in 5 mins from same IP | Block IP, log incident | Critical |
| **Message Flooding** | >20 messages from one user in 1 minute | Rate-limit user, notify moderators | High |
| **Geographic Anomaly** | Login from different country within 1 hour | Request re-auth, temporary account hold | High |
| **Encrypted Payload Tampering** | Authentication tag validation failure | Reject message, quarantine sender | Critical |
| **Coordinated Multi-Account Activity** | Same message sent from 3+ accounts to 1 target | Flag as potential spam/attack, escalate | High |
| **Behavioral Deviation** | User activity deviates >2σ from baseline | Increase monitoring, flag for auditor_bot | Medium |
| **Suspicious File Transfer** | Attempts to transfer files in encrypted channel | Block, log, require admin approval | High |

#### Response Actions
- **Rate Limiting**: Temporarily restrict user message sending
- **Session Termination**: Immediately end suspicious sessions
- **IP Blocking**: Add to temporary blocklist (30-min to 24-hour duration)
- **Account Hold**: Require additional authentication for next login
- **Escalation**: Trigger BUZZ! and notify administrators
- **Logging**: Full incident record with forensic metadata

#### Threat Intelligence Database
- Store pattern signatures for repeated attacks
- Learn from past incidents to improve future detection
- Share anonymized threat data across instances (if distributed)

---

### 3. buzz_guard

**Purpose**: Proactive alert orchestration and high-severity incident notification  
**Trigger**: Called by sentinel_bot or auditor_bot on critical events  
**Autonomy Level**: Full (orchestrates multi-channel alerts, escalation hierarchy)

#### Responsibilities
- Aggregate security alerts from other agents
- Determine alert severity and escalation level
- Trigger BUZZ! notification system for critical events
- Route alerts to appropriate stakeholders (user, admin, security team)
- Maintain alert history and incident timeline
- Implement alert fatigue prevention (deduplication, throttling)

#### Alert Severity Levels & Actions

| Severity | Criteria | Channels | BUZZ! | Escalation |
|----------|----------|----------|-------|------------|
| **Critical** | Unauthorized access, active breach, key compromise | Email, SMS, In-app, Dashboard | Yes (10s repeat) | Admin + Security Team |
| **High** | Policy violation, brute force, account anomaly | Email, In-app, Dashboard | Yes (5s) | Admin Team |
| **Medium** | Permission change, unusual pattern, compliance issue | In-app, Dashboard | Optional | Assigned Moderator |
| **Low** | Routine audit, scheduled report, key rotation due | Dashboard, Email (digest) | No | User |

#### BUZZ! Notification Behavior
- **Classic Sound**: Windows Messenger BUZZ! notification (configurable)
- **Visual Alert**: Animated notification with escalation counter
- **Duration**: Repeats every 5-10 seconds until acknowledged
- **Persistence**: Alert remains in UI until user confirms/dismisses
- **Multi-Device**: If user has multiple sessions, BUZZ! triggers on all

#### Alert Aggregation & Deduplication
- Deduplicate identical alerts within 5-minute window
- Combine related alerts into incident clusters
- Suppress alerts if same user already notified in past 30 minutes
- Implement exponential backoff for repeated similar incidents

#### Incident Timeline
- Track all security events in chronological order
- Correlate related events (same user, IP, target account)
- Generate incident summaries with recommended actions
- Store timeline for forensic analysis and compliance

---

## Security Policies

### Encryption & Key Management

**E2EE Requirements**
- All messages encrypted using ChaCha20-Poly1305 (application level)
- TLS 1.3 for transport encryption
- Key exchange: X25519 Elliptic Curve Diffie-Hellman
- Perfect Forward Secrecy: Ephemeral session keys

**Key Rotation**
- User keys rotated every 30 days (automatic reminder at day 25)
- Server archive keys rotated every 90 days
- Compromised keys must be rotated within 24 hours (auditor_bot verification)
- All historical messages re-keyed after rotation

**Key Storage**
- Client-side: Encrypted in browser LocalStorage with user passphrase
- Server-side: Never stores user private keys; only public keys and encrypted sessions
- Master keys stored in HSM (Hardware Security Module) in production

### User Authentication & Authorization

**Authentication Methods**
- Primary: Username + passphrase (minimum 12 characters, complexity required)
- Secondary: TOTP (Time-based One-Time Password) with QR code enrollment
- Session tokens: JWT with 1-hour expiration, refresh tokens (7-day max lifetime)

**Authorization Levels**
- **User**: Send/receive messages, manage own contacts
- **Moderator**: View audit logs, manage user permissions, create reports
- **Administrator**: Full system access, agent configuration, key management
- **Security Team**: Read-only access to threat intelligence and forensics

**Principle of Least Privilege**
- All agents operate with minimal required permissions
- Admin actions require second-factor confirmation
- Permission changes logged by auditor_bot with change reason

### Message Handling & Compliance

**Message Retention**
- Client-side: User controls local message storage
- Server-side: Encrypted messages stored for 90 days (auditable retention)
- Archive access: Only with explicit user consent or legal warrant

**Message Integrity**
- Every message includes HMAC-SHA256 authentication tag
- Tampering detected by sentinel_bot → reject + log + escalate
- Replay attack prevention using message nonce + timestamp

**Content Policies**
- Messages scanned for forbidden patterns (auditor_bot)
- Prohibited content: Malware distribution links, credential dumps
- Violations quarantined for review, not deleted immediately

### Network Security

**Connection Requirements**
- All connections require TLS 1.3 minimum
- Certificate pinning for known servers
- HSTS (HTTP Strict-Transport-Security) enabled

**IP Whitelisting (Optional)**
- Enterprise deployments can enable IP whitelisting
- Geographic restrictions configurable per user
- VPN detection for anomalous patterns

**DDoS Protection**
- Rate limiting per IP (100 connections/minute global, 10/minute per user)
- Connection throttling during detected attacks
- Automatic IP blocklisting for persistent abusers

---

## Compliance & Auditing

### Audit Logging Requirements
- All security events logged with timestamp, actor ID, action, result
- Logs immutable (append-only database, no updates/deletes)
- Retention: 1 year minimum for compliance
- Access to audit logs restricted to Security Team + Compliance

### Compliance Frameworks
- **GDPR**: User data deletion on request (auditor_bot enforces)
- **HIPAA**: Encryption, access controls, audit trails (if handling healthcare data)
- **SOC 2**: Regular audits, incident response, security policies
- **NIST Cybersecurity Framework**: Identify, Protect, Detect, Respond, Recover

### Incident Response Procedure
1. **Detection**: sentinel_bot identifies threat → escalates to buzz_guard
2. **Alerting**: buzz_guard triggers BUZZ! and notifies admin
3. **Investigation**: Security team reviews incident timeline + metadata
4. **Containment**: Affected accounts isolated, sessions terminated
5. **Eradication**: Root cause analysis, policy updates if needed
6. **Recovery**: Users restored to safe state, keys may be rotated
7. **Lessons Learned**: auditor_bot generates incident report

---

## Agent Configuration & Override

### Manual Override Procedures
- Administrators can override agent decisions via admin dashboard
- All overrides logged with administrator ID + reason
- Overrides trigger audit alert (Medium severity)
- Cannot override Critical-level agent decisions without second approval

### Agent Tuning Parameters
- Threat detection sensitivity: 0.5-1.0 (default: 0.75)
- Alert deduplication window: 5-60 minutes (default: 5)
- Rate limit thresholds: Configurable per user class
- Key rotation reminder: 7-30 days before expiration (default: 5)

### Disabling Agents (Emergency Only)
- auditor_bot: Cannot be disabled (always required for compliance)
- sentinel_bot: Can be disabled with 2-admin approval + 24-hour notice
- buzz_guard: Can be disabled per-user (user preference)

---

## Testing & Validation

### Agent Testing Requirements
- Unit tests: Each agent rule has corresponding test case
- Integration tests: Multi-agent workflows (e.g., detection → escalation → alert)
- Penetration testing: Red team exercises quarterly
- Compliance validation: External audit annually

### Test Scenarios
- **E2EE Verification**: Send encrypted message, confirm server cannot read
- **Tamper Detection**: Modify encrypted payload, verify sentinel_bot detects
- **Brute Force Protection**: Send 10 failed auth attempts, verify IP block
- **False Positive Rate**: Ensure <1% false positive rate for Medium+ alerts
- **Performance**: Agent processing <500ms per event at 1000 msg/sec throughput

---

## Related Documents

- `client/src/security/encryption.ts`: Client-side encryption implementation
- `server/src/agents/`: Agent source code and rules engine
- `server/src/database/schema.sql`: Audit log schema and security tables

