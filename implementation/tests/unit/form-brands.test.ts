import { describe, expect, it } from "vitest";
import { renderIdentify, selectBrand } from "../../apps/pid-form/src/page.js";

/**
 * ADR 0010 §2: public demonstrations are generic; a real organisation's look is shown only on the one
 * host behind Cloudflare Access, and only while a client profile configures it.
 */
const BRANDED = "edtp-cliente.murcata.es";
const client = { "pid-1": "fnmt", "rpi-1": "corpme" };

describe("which look a page wears", () => {
  it("is neutral by default, and for an unknown brand", () => {
    expect(selectBrand({}, "pid-1", "edtp-pid.murcata.es", BRANDED).key).toBe("demo");
    expect(selectBrand({ "pid-1": "nope" }, "pid-1", BRANDED, BRANDED).key).toBe("demo");
  });

  it("is a client's only on the protected host", () => {
    expect(selectBrand(client, "pid-1", BRANDED, BRANDED).key).toBe("fnmt");
    expect(selectBrand(client, "rpi-1", BRANDED, BRANDED).key).toBe("corpme");
    expect(selectBrand(client, "pid-1", "edtp-pid.murcata.es", BRANDED).key).toBe("demo");
  });

  it("is unrestricted when no protected host is configured, as in laptop sessions", () => {
    expect(selectBrand(client, "pid-1", "localhost", undefined).key).toBe("fnmt");
  });

  it("names no real organisation on a neutral page", () => {
    const html = renderIdentify({
      brand: selectBrand({}, "rpi-1", "edtp-pid.murcata.es", BRANDED),
      state: {},
      credentialName: "Poder de representación",
    });
    expect(html).toContain("No es un servicio real");
    expect(html).not.toMatch(/FNMT|CORPME|Registradores/);
    expect(html).not.toContain("<img");
  });
});
