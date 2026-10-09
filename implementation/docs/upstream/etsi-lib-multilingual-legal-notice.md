# Upstream issue draft — `LoTELegalNotice` is modelled as a plain string

**Not filed.** For `eu-digital-identity-wallet/eudi-lib-kmp-etsi-1196x2`. Drafted 9 October 2026 from a
defect report by FNMT-RCM's team, reproduced here.

---

**Title:** `PolicyOrLegalNotice.LegalNotice` reads `LoTELegalNotice` as a plain string; a list carrying a multilingual one does not parse

**What happens**

Decoding a list of trusted entities whose `PolicyOrLegalNotice` carries a legal notice written as a
multilingual character string fails:

```
kotlinx.serialization.json.internal.JsonDecodingException:
  Expected JsonPrimitive, but had JsonObject as the serialized body of string at element: $.LoTELegalNotice
```

```json
"PolicyOrLegalNotice": [
  { "LoTELegalNotice": { "lang": "en", "value": "…" } }
]
```

The whole list is refused, so a consumer gets no trust anchor from it.

**Where**

`119602-data-model/src/commonMain/kotlin/eu/europa/ec/eudi/etsi119602/datamodel/ListAndSchemeInformation.kt`,
`PolicyOrLegalNotice.LegalNotice`:

```kotlin
@SerialName(ETSI19602.LOTE_LEGAL_NOTICE) @Required val legalNotice: String,
```

Seen at `v0.4.0-alpha.1` (commit `7222a085dedc66b470fb132ea44ba8049f3e9f1c`) and unchanged on `main`
on 9 October 2026.

**What the specification says**

ETSI TS 119 602 V1.1.1, clause 6.3.11: the `PolicyOrLegalNotice` component shall contain either "a
sequence of `LoTEPolicy` elements which shall be multilingual pointers (see clause 6.1.4)" or "a
sequence of `LoTELegalNotice` elements which shall be multilingual character strings (see clause
6.1.4)". Clause 6.1.4: a multilingual character string consists of a language tag and the text.

The sibling `Policy.policy` is already a `MultiLanguageURI`.

**Suggested change**

Type `legalNotice` as the data model's own `MultilanguageString`. If lists written with a plain string
exist and are to keep loading, a serializer accepting both forms would do it.

**Reproduction**

`Json { ignoreUnknownKeys = true }.decodeFromString(ListSerializer(PolicyOrLegalNoticeSerializer), …)`
on the fragment above fails before the change and succeeds after.

---

## What this repository does meanwhile

Deviation **WD-10** of the test wallet (`tools/test-wallet/deviations.md`) rebuilds that one module
with a serializer that accepts both forms and keeps the property a `String`, so the library's other
published modules are unaffected. It is a workaround for our own modified builds and for nothing else.

A related observation, not part of the issue: the model's key for the pointers is
`PointerToOtherLoTE`; the reference lists and FNMT-RCM's write `PointersToOtherLoTE`, which the model
reads past. Clause 6.3 of the specification names the component `PointerToOtherLoTE`. Which spelling a
list should use was not settled here.
