# Banco Horizonte: a retail-bank app style, and login with the wallet

**Status:** approved 21 November 2026, for a demonstration on 24 November. The look and the login (L1–L4) are built; A0–A5 and the client-brand profile are next.
**Applies to:** `apps/demo-onboarding` (Banco Horizonte, ADR 0012).

## What changes

1. **The look of a Spanish retail bank's mobile app**, applied to the whole demonstration:
   - a white screen with the logo, a bell and a menu in the top bar;
   - two decorative colour shapes in the top corners;
   - a large greeting;
   - labels above the inputs;
   - full-width buttons, the primary one black and the secondary one outlined;
   - a checklist of steps between phases;
   - plain error screens with one illustration and one action.
2. **The account opening follows the six phases** a retail bank's digital onboarding uses. The wallet
   replaces the phases it makes unnecessary, and the page says so.
3. **A new use case: login.** A customer who opened an account signs in by presenting their PID. Only the
   personal administrative number is asked for, and nothing is typed.
4. **Two brands from the same code:**
   - **Banco Horizonte,** at the public address. Fictitious: its own name, mark and colours.
   - **A client brand profile,** on a second hostname behind Cloudflare Access only, never public. The
     logo and colours are files placed on the VM, not in git. It needs the client's written permission
     (the same conditions as a branded wallet build, CLAUDE.md §6.22).

The simulated "onboarding of today", the side-by-side comparison, the loan, the back office and the
technical panel stay. They take the new look.

## Wireframes

The layout is mobile-first. On a desktop the screen is centred, 420 px wide.

### L1 · Home and login

```
┌────────────────────────────────┐
│ ▓ Demonstration environment…   │  ← band, always
│ [mark] Banco Horizonte   🔔  ☰ │
│ ◖                            ◗ │  ← corner shapes
│                                │
│ Buenos días                    │
│                                │
│ Accede a tu banca con tu       │
│ Cartera Digital Europea.       │
│ Sin usuario ni contraseña.     │
│                                │
│                                │
│ [■ Entrar con mi cartera     ] │  ← primary, black
│ [□ Hacerme cliente           ] │  ← secondary, outlined
│  Otras formas de acceso ⓘ      │  ← "not in this demonstration"
└────────────────────────────────┘
```

- **No identifier or password field anywhere.** A page that looks like a bank's login must not collect
  credentials, and here there are none to collect.
- The ☰ menu is cosmetic: open an account, language, branches, security. The language entry is live
  only if English is done (out of scope for the 24th).

### L2 · Presenting the PID

```
│ Entrar con tu cartera          │
│ Banco Horizonte pide a tu      │
│ cartera:                       │
│  · tu número de documento      │
│                                │
│ [■ Abrir mi cartera          ] │  ← same device
│  Desde otro dispositivo: QR    │  ← cross-device, ADR 0009/0012
│                                │
│          • • •                 │
│  Conectando de forma segura    │
```

### L3 · Signed in

```
│ Buenas tardes, Elena           │  ← the name the bank keeps, not
│                                │    one the wallet sent now
│ ┌ Cuenta Online ────────────┐  │
│ │ ES00 0000 0000 0000 0000  │  │
│ │ 0,00 €                    │  │
│ └───────────────────────────┘  │
│ ┌ Tarjeta de débito ────────┐  │
│ │ •••• 0000   Activa        │  │
│ └───────────────────────────┘  │
│ Tareas pendientes (1)        › │  ← if the contract is unsigned
│                                │
│ ✓ Identificado con tu cartera  │
│   Datos pedidos: 1. Guardados  │
│   por el banco para entrar: 1  │
│ [□ Salir                     ] │
```

### L4 · Not a customer, and the errors

```
│          ⚠                     │
│ No te hemos encontrado         │
│ como cliente                   │
│ Si aún no tienes cuenta,       │
│ hazte cliente en unos minutos. │
│ [■ Hacerme cliente           ] │
│ [□ Salir                     ] │
```

The same screen pattern covers the other outcomes:

| Outcome | Heading |
|---|---|
| Declined in the wallet | No has compartido tus datos |
| Request expired | La solicitud ha caducado |
| PID not valid, revoked or untrusted | No hemos podido verificar tu identidad |
| Our failure, e.g. `trust_list_unavailable` | ¡Ups! Algo ha ido mal, with the reference to look up |

### A0 · Before you start (account opening)

```
│ Cuenta Online sin comisiones   │
│ ☑ Cuenta corriente             │
│   0 € de gestión y mantenimiento│
│ ☑ Tarjeta de débito            │
│   0 € de emisión y mantenimiento│
│ ☑ Una app ágil y fiable        │
│                                │
│ Para abrir tu cuenta           │
│ necesitarás:                   │
│ 👤 Ser mayor de 18 años        │
│ ▣ Tu Cartera Digital Europea   │
│   con tu PID                   │
│   (en vez del documento, la    │
│   foto y el vídeo)             │
│ [■ Continuar                 ] │
```

### A1 · Personal details: the PID, then contact

```
│ Datos personales               │
│ Empezamos por identificarte    │
│ [■ Identificarme con mi cartera]│
│ ── after the presentation ──   │
│ ✓ Verificado · firmados por el │
│   emisor de tu PID             │
│ Nombre        Elena        🔒  │
│ Apellidos     García Ruiz  🔒  │
│ Nacimiento    12/04/1990   🔒  │
│ Nacionalidad  ES           🔒  │
│ Documento     ········     🔒  │
│ Dirección     C/ …, 30001  🔒  │
│ Email   [                  ]   │
│ Móvil +34 [                ]   │
│ [■ Continuar                 ] │
```

Then **"Verifica tu móvil"**: a six-box code, simulated, with the page saying so. After that, the
checklist screen:

```
│ Genial, ya has completado      │
│ tus datos personales           │
│ ● Introduce tus datos     ✓    │
│ ● Verifica tu identidad   ✓    │  ← done by the wallet
│ ○ Actividad económica          │
│ ○ Configura tu cuenta          │
│ [■ Continuar                 ] │
```

Rejections at this step use L4's pattern:
- **Under 18,** from the date of birth: "Para abrir una cuenta debes ser mayor de edad".
- **Already a customer,** if the document number is already known: "Ya eres cliente", with *Entrar con
  mi cartera*.

### A2 · Identity verification: what the wallet replaced

```
│ Has verificado tu identidad    │
│ correctamente                  │
│ Sin vídeo, sin foto del        │
│ documento, sin selfie.         │
│ Tu cartera presentó tu PID y   │
│ el banco comprobó:             │
│ ✓ la firma del emisor          │
│ ✓ que el emisor es de confianza│
│ ✓ que está vigente y no        │
│   revocado                     │
│ ✓ que la presentó tu móvil     │
│ [■ Continuar                 ] │
```

The checks shown are the ones the platform's result names. None is invented.

### A3 · Economic activity, simulated

The KYC is typed, as today:
- the main activity (radio buttons);
- the monthly income, as a range;
- whether the person is politically exposed;
- the tax residence, for FATCA and CRS.

Every input is fictitious and nothing is assessed, and the screen says so. Optionally, **"Aporta tu
certificado de ingresos desde tu cartera"**: the income certificate the loan already uses, presented
the same way.

### A4 · Set up your account

```
│ Configura tu cuenta            │
│ Tu acceso                      │
│ ▣ Entrarás con tu Cartera      │
│   Digital Europea. No necesitas│
│   crear una contraseña.        │
│ Tus datos                      │
│ [■ Aceptar todo              ] │
│ [□ Rechazar todo             ] │
│ Tu oficina                     │
│ Oficina 0001 · Murcia (ficticia)│
│ [■ Confirmar                 ] │
```

### A5 · Sign

- **Todo listo para firmar:** the contracts listed, with fictitious texts.
- **Confirma la operación:** a simulated code.
- **Ya eres cliente de Banco Horizonte:** the button *Entrar con mi cartera* goes to L1, so the
  demonstration continues straight into login.

## What the login keeps, and what it does not

- **When an account is opened,** the demonstration's process keeps, in memory:
  - an HMAC-SHA256 of the normalised document number, under a key generated when the process starts;
  - the given name, for the greeting;
  - the fictitious IBAN;
  - whether the contract is signed.

  It keeps no other PID value. Records go on restart and with the nightly reset, like the back office.
- **At login,** the policy asks for **`personal_administrative_number` only**. The value is hashed the
  same way, looked up and discarded in the same request. It is never logged and never shown.
- **The greeting's name is the bank's own record,** not something the wallet sent at login. That is the
  minimisation point the screen makes: "Datos pedidos: 1".
- **The limits, said on the page:**
  - a PID without a document number cannot be used to log in. That optional claim is the identifier, and
    the reference issuer's PIDs may lack it;
  - the PID is not a long-term identifier. This shows a bank recognising a customer, not a
    recommended way of binding an account.

## What it needs on the VM

- **A new intended use and policy** under Banco Horizonte's service, `edtp-test-bank-login`, asking for
  `personal_administrative_number` only. Registered with `register-bank-onboarding.mjs` and a new JSON.
  The user runs it.
- **Environment:** `ONBOARDING_LOGIN_POLICY`; the policy goes into `HOSTED_VERIFIER_POLICIES`,
  `HOSTED_VERIFIER_ORIGINS` and `HOSTED_VERIFIER_QR_POLICIES`.
- **The client-brand variant, only if the client agrees in writing:**
  - a second `demo-onboarding` service with `ONBOARDING_BRAND_DIR`;
  - a hostname with its DNS route (your Cloudflare credential);
  - a Cloudflare Access application on that hostname;
  - its origin added to the hosted verifier's origins.
- **The wallet still names Banco Horizonte** at consent, because that is the registered Relying Party.
  The branded variant does not change what the wallet shows, and must not be described as the client's
  own service.

## Order of work, for the 24th

1. The new look and L1–L4 (login), with tests.
2. A0–A5 (account opening in six phases).
3. The client-brand mechanism.
4. Deployment, confirmed by you, then a run with the test wallet: account opening, then login.

Out of scope for the 24th: English, the Digital Credentials API, and the permanent fix for the engine's
trust lists. That fix has to land before **4 December**, when the copies expire again.
