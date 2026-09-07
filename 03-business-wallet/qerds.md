# QERDS and Legally Valid Communication

**Status:** [PROPOSED-REGULATORY] / [PRODUCT] / [OPEN]

A legally valid communication channel based on Qualified Electronic Registered Delivery Services (QERDS) is a core Business Wallet area to analyse.

## eDelivery hypothesis

The European Commission eDelivery building block is a strong implementation candidate for interoperable message exchange, particularly through its AS4-based architecture.

**Important:** using eDelivery does not by itself make a service a QERDS. Qualification, trust-service obligations and the applicable eIDAS/QERDS requirements must be treated separately.

Candidate architecture:

```text
Business Wallet
      |
QERDS service abstraction
      |
Qualified service / QTSP boundary
      |
eDelivery / AS4 interoperability layer (candidate)
```

eDelivery supplies specifications, conformance services and reusable/sample components for secure message exchange, including AS4 Access Points and SMP/SML discovery. QERDS is an eIDAS trust service with provider, evidence and qualification obligations. The architecture may combine them, but the qualified service boundary and evidence remain explicit.

`[OPEN]` Requires validation: target eDelivery network, AS4 1.x/2.0 compatibility, discovery model, qualified provider, evidentiary semantics, retention, addressing and cross-border acceptance.

See [shared QERDS/eDelivery](../06-shared-capabilities/qerds-edelivery.md) and [Commission eDelivery](https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467110114/eDelivery).
