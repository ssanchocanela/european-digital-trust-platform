# Target Architecture

**Status:** [EXPERIMENTAL] product architecture, not a normative European architecture

```mermaid
flowchart TB
  subgraph Channels["Channels and customer systems"]
    BW["Business Wallet UI"]
    SYS["ERP / CRM / PIM / PLM / public systems"]
    WEB["Verifier web/mobile integration"]
  end
  subgraph Product["Platform-owned product layer"]
    API["API gateway and stable business contracts"]
    TEN["Tenant and issuer management"]
    ORG["Organisation, users, roles and mandates"]
    CAT["Credential catalogue and configurations"]
    POL["Eligibility / issuance / approval policies"]
    DEL["Delegation Profiles and workflows"]
    LIFE["Credential lifecycle"]
    DPP["DPP management"]
    AUD["Audit and evidence"]
  end
  subgraph Shared["Shared adapters and engines"]
    ASC["Authentic Source connectors"]
    ORCH["Issuance orchestrator"]
    EAD["Platform EUDI adapter"]
    PE["Wrapped protocol engine (EUDIPLO candidate)"]
    VER["Verifier engine"]
    TRUST["Trust and status resolution"]
    KEY["Key/KMS and QTSP adapters"]
    MSG["QERDS/eDelivery adapter"]
  end
  AS["External Authentic Sources"]
  EW["EUDI Wallets"]
  ECO["Registrars and trust lists"]
  QTSP["QTSP / qualified services"]
  DR["DPP Registry"]
  DH["DPP data hosts"]

  BW --> API
  SYS --> API
  WEB --> API
  API --> TEN
  API --> ORG
  API --> CAT
  API --> POL
  API --> DEL
  API --> LIFE
  API --> DPP
  API --> AUD
  AS <--> ASC
  ASC --> ORCH
  CAT --> ORCH
  POL --> ORCH
  DEL --> ORCH
  LIFE --> ORCH
  ORCH --> EAD
  EAD --> PE
  PE <--> EW
  VER <--> EW
  PE --> TRUST
  VER --> TRUST
  TRUST <--> ECO
  PE --> KEY
  ORG --> KEY
  KEY <--> QTSP
  ORG --> MSG
  MSG <--> QTSP
  DPP --> DR
  DPP --> DH
```

## Boundaries

- [PRODUCT] Configurable Delegation Profiles assign retrieval, eligibility, rules, approval and lifecycle work to customer, platform or hybrid workflow.
- [PRODUCT] Authentic Sources remain external and authoritative even when the platform connects to them, transforms observations or makes decisions.
- [PRODUCT] Business APIs, policies, workflows and domain state remain platform-owned; EUDIPLO stays behind the platform EUDI adapter.
- [SPECIFICATION] Wallet-facing exchange follows applicable EUDI protocols, formats and trust rules.
- [REGULATORY] Qualified services remain inside the accountable QTSP boundary; an adapter does not confer qualified status.
- [REGULATORY] The DPP Registry is the registration/indexing layer, while complete DPP data is maintained outside it by the Economic Operator or its provider.
- [OPEN] Platform execution does not settle Attestation Provider identity; EAA, PuB-EAA and QEAA allocations require legal/regulatory analysis.
- [OPEN] Deployment zones, tenancy topology, data residency, assurance levels and authoritative trust sources require validation.

See the [component model](component-model.md), [issuance service architecture](issuance-service-architecture.md), [integration model](integration-model.md), and [reuse strategy](reuse-strategy.md).
