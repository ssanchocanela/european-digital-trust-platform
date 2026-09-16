import type { EngineClient } from "@edtp/eudiplo-adapter";
import { EudiploIssuerAdapter } from "@edtp/eudiplo-adapter";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * The shape of a status change as it reaches the engine.
 *
 * Pinned because one field decides whether revocation works at all. The engine's `StatusUpdateDto`
 * marks `credentialConfigurationId` optional — "if omitted, all credentials linked to the session
 * are updated" — and the omitted path throws a `TypeORMError` and answers `500`. Measured on one
 * session with one status and two calls: without the field `500`, with it `204`.
 * `docs/interop-findings.md` A26.
 *
 * A test that asserted only "the adapter called the engine" would pass while revocation was
 * completely broken, which is what the contract tests could not catch: they cannot collect a
 * credential, so they never reach a status change that has anything to update.
 */

interface Call {
  readonly engineTenantRef: string;
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const recordingClient = (calls: Call[]): EngineClient =>
  ({
    request: async (
      engineTenantRef: string,
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ) => {
      calls.push({ engineTenantRef, method, path, body: body ?? {} });
      return {} as never;
    },
  }) as unknown as EngineClient;

const session = {
  ref: asId<"EngineSessionRef">("session-abc"),
  engineTenantRef: "rpi-1",
};

describe("a credential status change names its configuration", () => {
  it("sends credentialConfigurationId, because omitting it is the path that 500s", async () => {
    const calls: Call[] = [];
    const adapter = new EudiploIssuerAdapter(recordingClient(calls));

    await adapter.updateCredentialStatus({
      session,
      status: "REVOKED",
      policyId: "3cce4aba-53ef-43c5-b8d4-18ed30602455",
      policyVersion: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/session/revoke");
    expect(calls[0]?.body).toMatchObject({
      sessionId: "session-abc",
      credentialConfigurationId: "c-3cce4aba-53ef-43c5-b8d4-18ed30602455-v1",
    });
  });

  it("uses the version it was given, so a v2 policy does not address v1's configuration", async () => {
    // A published version's configuration is immutable and separately identified. Addressing the
    // wrong one would revoke an attestation issued under a different version of the policy.
    const calls: Call[] = [];
    const adapter = new EudiploIssuerAdapter(recordingClient(calls));

    await adapter.updateCredentialStatus({
      session,
      status: "SUSPENDED",
      policyId: "policy-1",
      policyVersion: 2,
    });

    expect(calls[0]?.body.credentialConfigurationId).toBe("c-policy-1-v2");
  });

  it("maps the three statuses to the engine's integers", async () => {
    // 0 valid, 1 revoked, 2 suspended. Sending the wrong integer would silently reinstate an
    // attestation the platform believes it revoked — and the engine does not enforce VCR_04.
    const calls: Call[] = [];
    const adapter = new EudiploIssuerAdapter(recordingClient(calls));

    for (const status of ["VALID", "REVOKED", "SUSPENDED"] as const) {
      await adapter.updateCredentialStatus({
        session,
        status,
        policyId: "p",
        policyVersion: 1,
      });
    }

    expect(calls.map((c) => c.body.status)).toEqual([0, 1, 2]);
  });
});
