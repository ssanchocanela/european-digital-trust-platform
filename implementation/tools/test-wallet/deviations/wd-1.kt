package eu.europa.ec.corelogic.config

// EDTP deviation WD-1 (tools/test-wallet/deviations.md, ADR 0023 §6). Copied by build.sh into the
// generated `edtptest` source set; no upstream file is edited for it. This build is a MODIFIED wallet.
//
// An issuer trust source that consults the EDTP sandbox's non-qualified EAA providers list, for the
// sandbox's EAA use case only. Configuring `eaaProviders` in `configureEtsiTrust` would do nothing at
// the pinned versions: wallet-core 0.30.2 combines the configured locations with the fixed profile
// set `SupportedLists.eu()`, which at ETSI consultation 0.4.0-alpha.1 has no EAA profile, and
// `SupportedLists.combine` drops a location without one (docs/interop-findings.md C16). So this
// builds the source itself, from the library's public pieces, with that profile added.
//
// AS-AP-10-010 (ISSU_10): a Wallet Unit SHALL validate a non-qualified EAA's signature *if it has
// access to* the EAA Provider's trust anchors. This is that access, for the sandbox's EAAs.

import eu.europa.ec.corelogic.model.DocumentIdentifier
import eu.europa.ec.eudi.etsi119602.consultation.DownloadSingleLoTE
import eu.europa.ec.eudi.etsi119602.consultation.LoadLoTEAndPointers
import eu.europa.ec.eudi.etsi119602.consultation.LotEMeta
import eu.europa.ec.eudi.etsi119602.consultation.ProvisionTrustAnchorsFromLoTEs
import eu.europa.ec.eudi.etsi119602.consultation.VerifyJwtSignature
import eu.europa.ec.eudi.etsi119602.consultation.eu
import eu.europa.ec.eudi.etsi119602.consultation.eu.ServiceDigitalIdentityCertificateType
import eu.europa.ec.eudi.etsi119602.consultation.eudiwJvm
import eu.europa.ec.eudi.etsi119602.datamodel.Uri
import eu.europa.ec.eudi.etsi1196x2.consultation.AttestationClassifications
import eu.europa.ec.eudi.etsi1196x2.consultation.AttestationIdentifier
import eu.europa.ec.eudi.etsi1196x2.consultation.AttestationIdentifierPredicate
import eu.europa.ec.eudi.etsi1196x2.consultation.ComposeChainTrust
import eu.europa.ec.eudi.etsi1196x2.consultation.DisposableContainer
import eu.europa.ec.eudi.etsi1196x2.consultation.SupportedLists
import eu.europa.ec.eudi.etsi1196x2.consultation.ValidateCertificateChainUsingPKIXJvm
import eu.europa.ec.eudi.etsi1196x2.consultation.VerificationContext
import io.ktor.client.HttpClient
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Base64
import kotlin.time.Duration.Companion.minutes

internal object EdtpSandboxEaaTrust {

    /** The use case the sandbox's EAAs are classified under, and its list configured for. */
    const val USE_CASE = "edtp-sandbox"

    // Substituted by build.sh from --profile sandbox / sandbox-strict and --sandbox-base.
    private const val EAA_LOTE = "__EDTP_EAA_LOTE__"
    private const val PID_LOTE = "__EDTP_PID_LOTE__"
    private const val WRPAC_LOTE = "__EDTP_WRPAC_LOTE__"
    private const val WRPRC_LOTE = "__EDTP_WRPRC_LOTE__"
    // A raw string: build.sh writes the regex with single backslashes (`\.`).
    private const val VCT_PREFIX_REGEX = """__EDTP_EAA_VCT_REGEX__"""

    /**
     * The sandbox's own service type identifiers (packages/sandbox-pki/src/lote.ts,
     * SANDBOX_EAA_SERVICE_TYPE): there is no ETSI value for a non-qualified EAA providers list.
     * The wallet selects a list's services by these, and does not check the list's LoTEType.
     */
    private const val SVC_TYPE = "https://sandbox.murcata.es/19602/SvcType/EAA"

    private val container = DisposableContainer()

    /** Upstream's profiles, plus the sandbox EAA use case; relaxed as upstream's demo config relaxes them. */
    private fun profiles(): SupportedLists<LotEMeta<VerificationContext>> {
        val eaa = LotEMeta<VerificationContext>(
            svcTypePerCtx = mapOf(
                VerificationContext.EAA(USE_CASE) to
                    LotEMeta.SvcAndEEProfile(Uri("$SVC_TYPE/Issuance"), null),
                VerificationContext.EAAStatus(USE_CASE) to
                    LotEMeta.SvcAndEEProfile(Uri("$SVC_TYPE/Revocation"), null),
            ),
            serviceDigitalIdentityCertificateType = ServiceDigitalIdentityCertificateType.EndEntityOrCA,
        )
        val upstream = SupportedLists.eu()
        fun LotEMeta<VerificationContext>.relax() =
            copy(svcTypePerCtx = svcTypePerCtx.mapValues { (_, v) -> v.copy(endEntityProfile = null) })
        return SupportedLists(
            pidProviders = upstream.pidProviders?.relax(),
            walletProviders = upstream.walletProviders?.relax(),
            wrpacProviders = upstream.wrpacProviders?.relax(),
            wrprcProviders = upstream.wrprcProviders?.relax(),
            pubEaaProviders = upstream.pubEaaProviders?.relax(),
            qeaProviders = upstream.qeaProviders?.relax(),
            eaaProviders = upstream.eaaProviders.mapValues { (_, v) -> v.relax() } + (USE_CASE to eaa),
        )
    }

    private val locations = SupportedLists(
        pidProviders = Uri(PID_LOTE),
        wrpacProviders = Uri(WRPAC_LOTE),
        wrprcProviders = Uri(WRPRC_LOTE),
        eaaProviders = mapOf(USE_CASE to Uri(EAA_LOTE)),
    )

    /** The issuer trust source: PID, WRPAC (for signed metadata), WRPRC and the sandbox EAA list. */
    val source: ComposeChainTrust<List<X509Certificate>, VerificationContext, TrustAnchor> by lazy {
        ProvisionTrustAnchorsFromLoTEs.eudiwJvm(
            loadLoTEAndPointers = LoadLoTEAndPointers(
                constraints = LoadLoTEAndPointers.Constraints.DoNotLoadOtherPointers,
                verifyJwtSignature = LoteSignature,
                // No file cache: WalletCoreConfigImpl has no Context for a cache directory. Lists are
                // fetched again after the in-memory TTL below.
                loadLoTE = DownloadSingleLoTE(HttpClient()),
            ),
            svcTypePerCtx = profiles(),
            pkix = ValidateCertificateChainUsingPKIXJvm(customization = { isRevocationEnabled = false }),
        ).cached(container, locations, ttl = 20.minutes)
    }

    /** Upstream's PID classification, plus every vct under the sandbox's prefix as a sandbox EAA. */
    val classifications = AttestationClassifications(
        pids = AttestationIdentifierPredicate.any(
            identifiers = setOf(
                AttestationIdentifier.MDoc(docType = DocumentIdentifier.MdocPid.formatType),
                AttestationIdentifier.SDJwtVc(vct = DocumentIdentifier.SdJwtPid.formatType),
            ),
        ),
        eaAs = mapOf(USE_CASE to AttestationIdentifierPredicate.sdJwtVcMatching(Regex(VCT_PREFIX_REGEX))),
    )

    /**
     * The LoTE's JWS checked against the leaf of its own `x5c`, as wallet-core's internal
     * `LoteJwtVerifier` does — which an app cannot call. ES256/ES384 and RS256, the JDK only.
     */
    private object LoteSignature : VerifyJwtSignature {
        override suspend fun invoke(jwt: String): VerifyJwtSignature.Outcome = try {
            val parts = jwt.split(".")
            require(parts.size == 3) { "not a compact JWS" }
            val dec = Base64.getUrlDecoder()
            val header = String(dec.decode(parts[0]))
            val alg = Regex("\"alg\"\\s*:\\s*\"([A-Z0-9]+)\"").find(header)?.groupValues?.get(1)
                ?: error("no alg")
            val x5c = Regex("\"x5c\"\\s*:\\s*\\[\\s*\"([A-Za-z0-9+/=]+)\"").find(header)?.groupValues?.get(1)
                ?: error("no x5c")
            val leaf = CertificateFactory.getInstance("X.509")
                .generateCertificate(ByteArrayInputStream(Base64.getDecoder().decode(x5c))) as X509Certificate
            val signed = "${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII)
            val raw = dec.decode(parts[2])
            val ok = when (alg) {
                "ES256" -> verify("SHA256withECDSA", leaf, signed, derEcdsa(raw))
                "ES384" -> verify("SHA384withECDSA", leaf, signed, derEcdsa(raw))
                "RS256" -> verify("SHA256withRSA", leaf, signed, raw)
                else -> error("unsupported alg $alg")
            }
            if (ok) VerifyJwtSignature.Outcome.Verified(jwt)
            else VerifyJwtSignature.Outcome.NotVerified(SecurityException("LoTE signature does not verify"))
        } catch (e: Exception) {
            VerifyJwtSignature.Outcome.NotVerified(e)
        }

        private fun verify(algorithm: String, leaf: X509Certificate, data: ByteArray, sig: ByteArray) =
            Signature.getInstance(algorithm).run {
                initVerify(leaf.publicKey)
                update(data)
                verify(sig)
            }

        /** JOSE's R||S to the DER SEQUENCE the JDK verifies. */
        private fun derEcdsa(raw: ByteArray): ByteArray {
            require(raw.size % 2 == 0) { "bad ECDSA signature length" }
            val half = raw.size / 2
            fun int(bytes: ByteArray): ByteArray {
                val v = BigInteger(1, bytes).toByteArray()
                return byteArrayOf(0x02, v.size.toByte()) + v
            }
            val body = int(raw.copyOfRange(0, half)) + int(raw.copyOfRange(half, raw.size))
            return byteArrayOf(0x30, body.size.toByte()) + body
        }
    }
}
