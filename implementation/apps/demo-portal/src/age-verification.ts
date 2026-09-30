import type { DemoCard, Health } from "./page.js";

/**
 * The age verification demos (ADR 0011): Lumen and Plaza, from the age_verification_platform
 * repository, on the same VM. They are shown with that project's wallet, the Age Verification app, not
 * with the EDTP wallet, and the cards say so: a visitor holding only one of the two would otherwise try
 * the wrong one.
 */
export interface AgeVerificationDemo {
  readonly url: string;
  readonly qrSvg: string;
  readonly health: Health;
}

export const ageVerificationCards = (
  lumen: AgeVerificationDemo,
  plaza: AgeVerificationDemo,
): DemoCard[] => [
  {
    key: "lumen",
    title: "Lumen: una sala solo para mayores de 18",
    summary:
      "Un catálogo ficticio que solo se abre con la app de verificación de edad. La sala recibe «18 o más», sin nombre ni fecha de nacimiento.",
    steps: [
      "Abra la página en el móvil que tiene la app de verificación de edad.",
      "Pulse «Verificar mi edad» y responda desde la app.",
      "Vuelva a la sala: el catálogo se abre durante 30 minutos.",
    ],
    url: lumen.url,
    qrSvg: lumen.qrSvg,
    health: lumen.health,
  },
  {
    key: "plaza",
    title: "Plaza: una red social que abre cuentas según la edad",
    summary:
      "El registro no pide la fecha de nacimiento: la app responde a 18, 15 y 13 por turnos, y Plaza abre una cuenta completa, con protecciones o supervisada.",
    steps: [
      "Abra la página en el móvil que tiene la app de verificación de edad.",
      "Cree una cuenta con datos ficticios y responda desde la app a cada pregunta.",
      "Vea qué cuenta le abre Plaza y qué se compartió.",
    ],
    url: plaza.url,
    qrSvg: plaza.qrSvg,
    health: plaza.health,
  },
];
