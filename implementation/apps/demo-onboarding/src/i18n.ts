/**
 * Every text the onboarding demonstration shows, by language.
 *
 * Spanish only, today. A second language is a second entry in `DICTIONARIES` with the same keys —
 * `tests/unit/demo-onboarding.test.ts` fails on a missing one — and `?lang=` selects it.
 *
 * Three wordings are deliberate (`docs/demonstration-script.md` §5): the data is "signed by the
 * issuer", never "by the State", because the issuer here is a test provider; the outcome is
 * "verified", with no level of assurance named; and the signature step says it is simulated, because
 * the platform does not sign.
 */

const es = {
  // --- shell ---
  band: "Entorno de demostración. Banco Horizonte no es un banco real y esta alta es ficticia. Use únicamente credenciales de prueba.",
  brandSub: "Banca digital",
  menuPersonal: "Particulares",
  menuBusiness: "Empresas",
  menuPrivate: "Banca Privada",
  menuHelp: "Ayuda",
  clientAccess: "Acceso clientes",
  footerLegal:
    "Banco Horizonte es una marca ficticia para una demostración de la European Digital Trust Platform. Ningún dato se guarda en esta página.",
  footerPrivacy: "Privacidad",
  footerSecure: "Conexión segura",
  footerTest: "Entorno TEST",
  recordedRibbon:
    "Reproducción grabada: sin cartera ni verificador. Los datos son ficticios y nadie los ha verificado.",
  techToggle: "Qué pasa por detrás",
  restart: "Reiniciar",
  shortcuts: "→ avanzar · R reiniciar · T panel técnico",

  // --- cover ---
  coverTitle: "Elige cómo quieres verlo",
  coverLead: "La misma cuenta, contratada de dos maneras.",
  coverCurrentTitle: "Onboarding actual",
  coverCurrentBody: "Formulario, fotos del documento, selfie y revisión manual.",
  coverEudiTitle: "Onboarding con EUDI Wallet",
  coverEudiBody: "Tres pasos, con los datos de tu PID firmados por su emisor.",
  coverCompare: "Comparar lado a lado",
  coverCurrentCta: "Ver el alta tradicional",
  coverEudiCta: "Ver el alta con la cartera",
  badgeNew: "Nuevo",

  // --- flow header ---
  modeCurrent: "Onboarding actual",
  modeEudi: "Con EUDI Wallet",
  stepOf: "Paso {n} de {total}",
  timer: "Tiempo",
  simulated: "Simulado",

  // --- EUDI: product ---
  productTitle: "Cuenta Online Horizonte",
  productLead: "Tu cuenta sin comisiones, abierta en minutos.",
  productBenefit1: "Sin comisiones de mantenimiento",
  productBenefit2: "Tarjeta de débito gratis",
  productBenefit3: "Bizum y transferencias inmediatas",
  productCtaWallet: "Hazte cliente con tu Cartera Digital Europea",
  productCtaClassic: "Alta tradicional",

  // --- EUDI: consent ---
  consentTitle: "Comparte tu identidad de forma segura",
  consentBody:
    "Solo pedimos lo que la normativa exige para abrir tu cuenta. Tus datos llegan firmados por la entidad que emitió tu PID.",
  consentName: "Nombre y apellidos",
  consentNameWhy: "Para identificarte como titular",
  consentBirth: "Fecha de nacimiento",
  consentBirthWhy: "Para comprobar que eres mayor de edad",
  consentNationality: "Nacionalidad",
  consentNationalityWhy: "Obligación de conocimiento del cliente",
  consentDocument: "Número de identificación",
  consentDocumentWhy: "Para tu expediente de alta",
  consentAddress: "Domicilio",
  consentAddressWhy: "Para la correspondencia y el contrato",
  consentCta: "Continuar con mi wallet",

  // --- EUDI: connect ---
  connectTitle: "Conecta tu wallet",
  connectQr: "Escanéalo con tu EUDI Wallet",
  connectQrNote: "El código caduca en {s} s.",
  connectOpen: "Abrir mi wallet",
  connectOpenBody: "Se abrirá tu cartera. Revisa qué datos se piden y compártelos.",
  connectUseQr: "Mostrar un código QR",
  connectUsePhone: "Estoy en el móvil con la cartera",
  connectStarting: "Preparando la solicitud…",
  connectRetry: "Generar otra solicitud",
  statusWaiting: "Esperando a tu wallet",
  statusReceived: "Presentación recibida",
  statusVerified: "Datos verificados",
  phoneTitle: "En tu móvil",
  phoneAsks: "Banco Horizonte solicita estos datos",
  phoneBody:
    "Tu cartera te muestra quién los pide y qué pide. Apruébalo con tu PIN o tu huella.",
  phoneNote: "Ilustración: la aprobación ocurre en la cartera real.",
  errorUnavailable: "No hemos podido preparar la solicitud. Inténtalo de nuevo.",
  errorExpired: "La solicitud ha caducado antes de recibir tus datos.",
  errorDeclined: "Has cancelado la presentación en tu cartera.",
  errorRejected: "No hemos podido verificar la credencial presentada.",
  errorTrust: "No hemos podido confirmar quién emitió la credencial.",
  errorIncomplete: "La credencial no incluye todos los datos que necesitamos.",
  errorProtocol: "La cartera y el banco no han completado el intercambio.",
  errorMinor: "Para abrir esta cuenta tienes que ser mayor de edad.",

  // --- EUDI: data ---
  dataTitle: "Hemos recibido tus datos",
  dataLead: "No tienes que escribirlos: llegan de tu PID, verificados.",
  verifiedSeal: "Verificado con EUDI Wallet",
  adultCheck: "Mayoría de edad comprobada a partir de tu fecha de nacimiento",
  fieldGivenName: "Nombre",
  fieldFamilyName: "Apellidos",
  fieldBirthdate: "Fecha de nacimiento",
  fieldNationalities: "Nacionalidad",
  fieldDocument: "Número de identificación",
  fieldStreet: "Domicilio",
  fieldPostalCode: "Código postal",
  fieldLocality: "Localidad",
  fieldCountry: "País",
  kycTitle: "Solo nos falta esto",
  kycEmail: "Correo electrónico",
  kycPhone: "Teléfono móvil",
  kycActivity: "Actividad profesional",
  kycFunds: "Origen de los fondos",
  kycActivityOptions: "Empleada por cuenta ajena|Autónoma|Estudiante|Jubilada|Otra",
  kycFundsOptions: "Nómina|Actividad profesional|Ahorros|Otros",
  kycEmailSample: "laura.martinez@example.test",
  kycPhoneSample: "+34 600 000 000",
  continue: "Continuar",

  // --- EUDI: sign ---
  signTitle: "Revisa y firma",
  signProduct: "Cuenta Online Horizonte",
  signHolder: "Titular",
  signFees: "Comisiones",
  signFeesValue: "0 €",
  signCheck1: "He leído y acepto el contrato de la cuenta",
  signCheck2: "Acepto la política de privacidad",
  signCta: "Firmar y abrir cuenta",
  otpTitle: "Firma con código de un solo uso",
  otpNote: "Firma simulada: esta plataforma no firma con la cartera.",

  // --- EUDI: success ---
  successTitle: "¡Te damos la bienvenida, {name}!",
  successLead: "Tu cuenta ya está activa.",
  successIban: "IBAN (ficticio)",
  successIbanValue: "ES00 0000 0000 0000 0000 0000",
  successCard: "Tarjeta virtual",
  successCompare: "Ver comparativa",

  // --- the loan: wallet only, no comparison ---
  coverLoanTitle: "Préstamo Horizonte",
  coverLoanBody: "Pide un préstamo identificándote con tu cartera, sin fotocopias del DNI.",
  coverLoanCta: "Pedir un préstamo con la cartera",
  loanTitle: "Préstamo Horizonte",
  loanLead: "Elige cuánto necesitas y en cuánto tiempo quieres devolverlo.",
  loanAmount: "Importe",
  loanTerm: "Plazo",
  loanMonths: "{n} meses",
  loanMonthly: "Cuota mensual",
  loanRate: "TIN {rate} % (condiciones ficticias)",
  loanRateLabel: "Tipo de interés nominal",
  loanTotal: "Total a devolver",
  loanCta: "Pídelo con tu Cartera Digital Europea",
  loanFictitious: "Producto y condiciones ficticios. No se concede ningún préstamo.",
  loanConsentBody:
    "Para estudiar tu préstamo necesitamos identificarte. Tus datos llegan firmados por la entidad que emitió tu PID.",
  loanEmployment: "Situación laboral",
  loanEmploymentOptions: "Contrato indefinido|Contrato temporal|Autónoma|Jubilada|Otra",
  loanIncome: "Ingresos netos mensuales (€)",
  loanIncomeSample: "2400",
  loanDecisionTitle: "Estudiando tu solicitud…",
  loanDecisionNote:
    "Decisión simulada: se calcula con los ingresos que has escrito. El PID acredita quién eres, no tu solvencia.",
  loanOfferTitle: "{name}, tu préstamo está preconcedido",
  loanOfferLowerTitle: "{name}, podemos ofrecerte un importe menor",
  loanOfferLowerBody:
    "Con los ingresos indicados no llegamos a los {asked} que pedías. Esta es nuestra oferta.",
  loanAccept: "Aceptar la oferta",
  loanRefusedTitle: "Ahora no podemos ofrecerte este préstamo",
  loanRefusedBody:
    "Con los ingresos indicados, la cuota superaría lo que consideramos asumible.",
  loanCheck1: "He leído y acepto el contrato del préstamo y la información precontractual",
  loanSignCta: "Firmar y recibir el préstamo",
  loanSuccessTitle: "¡Hecho, {name}!",
  loanSuccessLead: "Hemos abonado {amount} en tu cuenta (ficticia).",

  // --- the loan's second presentation: an income certificate ---
  incomeIntroTitle: "Acredita tus ingresos",
  incomeIntroBody:
    "Sin nóminas en PDF: comparte tu certificado de ingresos desde la cartera. Pedimos solo lo necesario para estudiar el préstamo.",
  incomeAskIncome: "Ingreso neto mensual",
  incomeAskIncomeWhy: "Para calcular la cuota que puedes asumir",
  incomeAskContract: "Tipo de contrato",
  incomeAskContractWhy: "Para valorar la estabilidad de tus ingresos",
  incomeAskSince: "Antigüedad",
  incomeAskSinceWhy: "Desde cuándo trabajas en tu empresa",
  incomeCta: "Compartir mi certificado de ingresos",
  incomeConnectTitle: "Comparte tu certificado de ingresos",
  incomeVerifiedTitle: "Ingresos acreditados",
  incomeVerifiedLead: "Los datos llegan firmados por la entidad que emitió tu certificado.",
  incomeNet: "Ingreso neto mensual",
  incomeContract: "Tipo de contrato",
  incomeSince: "Antigüedad desde",
  incomeContract_permanent: "Indefinido",
  incomeContract_temporary: "Temporal",
  errorHolderMismatch:
    "El certificado de ingresos no corresponde a la persona identificada con el PID.",
  loanDecisionNoteVerified:
    "Regla de demostración aplicada al ingreso de tu certificado, que está verificado. Los datos del certificado son ficticios.",

  // --- the back office: behind Cloudflare Access, in memory, half an hour ---
  boTitle: "Back-office · Expedientes",
  boLead: "Las solicitudes que han llegado con la cartera, según se verifican.",
  boNote:
    "Vista temporal de demostración: los expedientes viven en memoria, como mucho 30 minutos y 20 a la vez, y se pierden al reiniciar. Solo datos de prueba.",
  boEmpty: "Aún no ha llegado ninguna solicitud.",
  boProductAccount: "Cuenta Online Horizonte",
  boProductLoan: "Préstamo Horizonte",
  boProductUnknown: "Solicitud en curso",
  boStateSigned: "Firmado",
  boStateOpen: "En curso",
  boDocuments: "Documentos presentados",
  boDocPid: "PID",
  boDocIncome: "Certificado de ingresos",
  boReceived: "recibido y verificado",
  boPending: "pendiente",
  boIdentity: "Identidad (PID)",
  boIncome: "Ingresos (certificado)",
  boDecision: "Préstamo",
  boVerified: "verificado",
  boDeclared: "declarado por la página",
  boAdult: "Mayor de edad",
  boYes: "Sí",
  boNo: "No",
  boAsked: "Importe solicitado",
  boGranted: "Importe concedido",
  boAgo: "hace {n} min",

  // --- current flow ---
  currentFormTitle: "Rellena tus datos",
  currentTyped: "Campos escritos a mano",
  currentDocTitle: "Fotografía tu DNI",
  currentDocFront: "Anverso",
  currentDocBack: "Reverso",
  currentDocBlur: "Imagen borrosa, inténtalo de nuevo",
  currentDocOk: "Imagen aceptada",
  currentCapturing: "Capturando…",
  currentSelfieTitle: "Selfie y prueba de vida",
  currentSelfieHint: "Gira la cabeza lentamente",
  currentSelfieFail: "Poca iluminación, inténtalo de nuevo",
  currentSelfieOk: "Prueba de vida superada",
  currentReviewTitle: "Estamos revisando tu documentación",
  currentReviewBody: "Te avisaremos en 24-48 h. Tu alta queda pendiente.",
  currentReviewForce: "Forzar la aprobación",
  currentOtpTitle: "Firma con el código que te hemos enviado",
  currentDoneTitle: "Cuenta abierta",
  currentDoneBody: "Tras la revisión manual, la cuenta queda activa.",
  currentRetries: "Reintentos",
  currentDocs: "Documentos subidos",
  currentWait: "Espera",
  currentAuto: "Avance automático",
  currentFields:
    "Nombre=Laura|Primer apellido=Martínez|Segundo apellido=Soler|DNI=00000000T|Fecha de nacimiento=14/03/1992|Nacionalidad=Española|Dirección=Carrer de l'Exemple 123|Código postal=08000|Localidad=Barcelona|Provincia=Barcelona|Correo electrónico=laura.martinez@example.test|Teléfono=600 000 000|Actividad profesional=Empleada",
  currentPending: "pendiente",

  // --- side by side ---
  sideDone: "Con la EUDI Wallet ya eres cliente. El alta tradicional sigue en: {where}.",

  // --- comparison ---
  compareTitle: "La misma cuenta, dos caminos",
  compareTime: "Tiempo",
  compareSteps: "Pasos",
  compareTyped: "Campos escritos a mano",
  compareDocs: "Documentos subidos",
  compareRetries: "Reintentos",
  compareReview: "Revisión manual",
  compareYes: "Sí, 24-48 h",
  compareNo: "No",
  compareNotRun: "sin ejecutar",
  compareNote:
    "El recorrido actual es una simulación con tiempos orientativos. El recorrido con la cartera es el tiempo medido en esta sesión.",
  compareNoteRecorded: "El recorrido con la cartera se ha reproducido de una grabación.",
  compareAgain: "Volver al inicio",

  // --- technical panel ---
  techTitle: "Qué pasa por detrás",
  techBusiness: "Vista negocio",
  techTechnical: "Vista técnica",
  techRecorded: "grabado",
  techNotObserved: "no observable desde el banco",
  techEmpty: "Los eventos aparecen al ejecutar el recorrido con la cartera.",
  tech1Business: "El banco prepara la petición con los datos que necesita",
  tech1Technical:
    "La plataforma crea la petición de presentación (OpenID4VP) a partir de la política del banco",
  tech2Business: "La cartera comprueba quién es el banco antes de mostrarte nada",
  tech2Technical:
    "La cartera obtiene la petición firmada y valida el certificado de acceso del relying party",
  tech3Business: "Apruebas, y la cartera envía solo los datos aceptados",
  tech3Technical:
    "La cartera devuelve la presentación del PID (SD-JWT VC) con divulgación selectiva",
  tech4Business: "La plataforma comprueba que los datos son auténticos y están en vigor",
  tech4Technical:
    "Firma del emisor contra la lista de confianza de proveedores de PID (TEST), vigencia y estado de revocación",
  tech5Business: "Identidad verificada: los datos están listos para tu alta",
  tech5Technical: "Resultado normalizado: solo los atributos que la política permite devolver",
} as const;

export type Dictionary = Readonly<Record<keyof typeof es, string>>;

export const DICTIONARIES: Readonly<Record<string, Dictionary>> = { es };

export const DEFAULT_LANGUAGE = "es";

export const dictionary = (
  lang: string | undefined,
): { readonly lang: string; readonly t: Dictionary } =>
  lang !== undefined && Object.hasOwn(DICTIONARIES, lang)
    ? { lang, t: DICTIONARIES[lang] as Dictionary }
    : { lang: DEFAULT_LANGUAGE, t: es };
