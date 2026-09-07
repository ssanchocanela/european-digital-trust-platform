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
    ORG["Organisation, users, roles and mandates"]
    DPP["DPP management"]
    POL["Policy and consent/intended-use orchestration"]
    AUD["Audit and evidence"]
  end
  subgraph Engines["Replaceable capability engines"]
    ISS["Issuer engine"]
    VER["Verifier engine"]
    TRUST["Trust and status resolution"]
    KEY["Key/KMS and QTSP adapters"]
    MSG["QERDS/eDelivery adapter"]
  end
  EW["EUDI Wallets"]
  ECO["Registrars, trust lists, authentic sources"]
  QTSP["QTSP / qualified services"]
  DR["DPP Registry"]
  DH["DPP data hosts"]

  BW --> API
  SYS --> API
  WEB --> API
  API --> ORG
  API --> DPP
  API --> POL
  API --> AUD
  API --> ISS
  API --> VER
  ISS <--> EW
  VER <--> EW
  ISS --> TRUST
  VER --> TRUST
  TRUST <--> ECO
  ISS --> KEY
  VER --> KEY
  ORG --> KEY
  KEY <--> QTSP
  ORG --> MSG
  MSG <--> QTSP
  DPP --> DR
  DPP --> DH
```

## Boundaries

- [PRODUCT] Business APIs and domain state remain platform-owned; protocol engines are replaceable adapters.
- [SPECIFICATION] Wallet-facing exchange follows the applicable EUDI protocols, formats and trust rules.
- [REGULATORY] Qualified services remain inside the accountable QTSP boundary; an adapter does not confer qualified status.
- [REGULATORY] The DPP Registry is the registration/indexing layer, while complete DPP data is maintained outside it by the Economic Operator or its provider.
- [OPEN] Deployment zones, data residency, assurance levels and authoritative trust sources require validation per service and Member State.

See the [component model](component-model.md), [integration model](integration-model.md) and [reuse strategy](reuse-strategy.md).
