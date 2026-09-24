/**
 * A branding-profile request from the operator page (ADR 0010 §2).
 *
 * The portal does not switch profiles. It holds no access to Docker or the host. It writes a request
 * file into a directory shared with the host, and a systemd path unit on the VM applies it with
 * `infra/demo-vm/apply-profile-request.sh`, which validates it again. This module only decides whether
 * a submitted form becomes a request.
 */
export interface ProfileRequest {
  readonly profile: string;
  readonly by: string;
  readonly at: string;
}

export type ProfileDecision =
  | { readonly ok: true; readonly request: ProfileRequest }
  | { readonly ok: false; readonly reason: string };

export const GENERIC_PROFILE = "generic";

export const decideProfileRequest = (input: {
  readonly profile: unknown;
  readonly permission: unknown;
  readonly who: string | undefined;
  readonly allowed: readonly string[];
  readonly sameOrigin: boolean;
  readonly now: Date;
}): ProfileDecision => {
  if (!input.who) return { ok: false, reason: "Sin sesión de Cloudflare Access." };
  if (!input.sameOrigin) {
    return { ok: false, reason: "La solicitud no procede de esta página." };
  }
  const profile = typeof input.profile === "string" ? input.profile : "";
  if (!input.allowed.includes(profile)) {
    return { ok: false, reason: "Perfil desconocido." };
  }
  if (profile !== GENERIC_PROFILE && input.permission !== "on") {
    return {
      ok: false,
      reason:
        "Un perfil de cliente requiere confirmar el permiso por escrito de la organización.",
    };
  }
  return { ok: true, request: { profile, by: input.who, at: input.now.toISOString() } };
};
