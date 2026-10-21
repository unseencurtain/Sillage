import { describe, expect, test } from "bun:test";
import { soapFaultMessage } from "../src/vendors/beautyfort/BeautyfortClient.ts";

describe("BeautyFort SOAP fault detection", () => {
  test("reads the unqualified faultstring BeautyFort actually returns", () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Body>
    <SOAP-ENV:Fault>
      <faultcode>SOAP-ENV:Server</faultcode>
      <faultstring>Invalid credentials</faultstring>
    </SOAP-ENV:Fault>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

    expect(soapFaultMessage(body)).toBe("Invalid credentials");
  });

  test("reads the prefixed form too", () => {
    const body = `<SOAP-ENV:Envelope><SOAP-ENV:Body><SOAP-ENV:Fault>
      <SOAP-ENV:faultstring>Order already exists</SOAP-ENV:faultstring>
    </SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

    expect(soapFaultMessage(body)).toBe("Order already exists");
  });

  test("returns null for a normal success body", () => {
    const body = `<SOAP-ENV:Envelope><SOAP-ENV:Body>
      <CreateOrderResponse><OrderReference>123</OrderReference></CreateOrderResponse>
    </SOAP-ENV:Body></SOAP-ENV:Envelope>`;

    expect(soapFaultMessage(body)).toBeNull();
  });
});
