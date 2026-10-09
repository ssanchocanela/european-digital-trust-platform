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

**What the bundled schema says**

`119602-data-model/src/commonMain/resources/1960201_json_schema.json` declares it otherwise:

```json
"LoTELegalNotice": { "type": "string" }
```

So the model agrees with the schema and disagrees with clause 6.3.11, and lists of both kinds are in
circulation: one written to the schema, one to the prose. This looks like an inconsistency in the
specification itself, worth raising with ETSI as well.

**Suggested change**

Read both forms: a multilingual character string and a plain string. Whether the property then
becomes a `MultilanguageString` (a plain string wrapped with a default language) or stays a `String`
(the text of either) is the maintainers' call; either way a list of the other kind stops failing whole.

**Reproduction**

`Json { ignoreUnknownKeys = true }.decodeFromString(ListSerializer(PolicyOrLegalNoticeSerializer), …)`
on the fragment above fails before the change and succeeds after.

---

## What this repository does meanwhile

Deviation **WD-10** of the test wallet (`tools/test-wallet/deviations.md`) rebuilds that one module
with a serializer that accepts both forms and keeps the property a `String`, so the library's other
published modules are unaffected. It is a workaround for our own modified builds and for nothing else.

A related observation, for a second issue rather than this one: the model's key for the pointers is
`PointerToOtherLoTE`, while the bundled schema, the reference lists and FNMT-RCM's all write
`PointersToOtherLoTE`. The model therefore reads past every pointer, and `LoadLoTEAndPointers` never
has one to follow. Clause 6.3 of the specification names the component in the singular. Aligning the
key would switch pointer-following on for every consumer, which is a change of behaviour and not only
of parsing; WD-10 does not make it.
