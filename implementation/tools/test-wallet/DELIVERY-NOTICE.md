# Notice to accompany a delivered build of the EDTP test wallet

Fill in the fields in brackets for the build being delivered, and hand this file over **with** the
APK. It is what `CLAUDE.md` §6.22 requires to travel with a build that leaves our hands.

---

**What this is.** An Android application built from the EUDI Wallet Reference Implementation,
`eudi-app-android-wallet-ui`, published by the European Commission. **It is a modified build, for
demonstrations only.** It is not the Reference Wallet, it is not an application of [client], and it is
not for real credentials or real personal data.

| | |
|---|---|
| Upstream | <https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui>, tag `Wallet/Demo_Version=2026.09.42-Demo_Build=42`, commit `43f362d2a720edb6d37a356b6a51b52b32c61f25` |
| This build | `[file name]`, SHA-256 `[hash]`, built `[date]` |
| Application | `[applicationId]`, shown as "[app name]" |
| Signed by | our test key, `OU=TEST ONLY` — not the Commission's and not [client]'s |
| Modifications | `[deviations, as the app's banner shows them]`; look: `[brand, or none]` |

**How it is modified.** Each modification is described in `tools/test-wallet/deviations.md` of the
repository below, and applied by `tools/test-wallet/build.sh`, which rebuilds this exact application
from the upstream tag. The application shows a banner on every screen naming them.

**Source.** The upstream source is at the address above. Our modifications, and the script that
applies them, are at <https://github.com/ssanchocanela/european-digital-trust-platform>, under
`implementation/tools/test-wallet/`.

**Licence.** The upstream work is licensed under the European Union Public Licence, version 1.2
(<https://joinup.ec.europa.eu/software/page/eupl>), and so is this modified build. The upstream
`LICENSE.txt` and `NOTICE.txt` apply unchanged. The licence comes with no warranty.
[The client's logo, where the build carries one, is the client's and is not covered by that licence.]

**No conformance is claimed** with the Architecture and Reference Framework or any Technical
Specification, and the application is not production-ready.
