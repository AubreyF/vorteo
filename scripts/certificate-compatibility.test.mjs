import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const expo = require("@expo/code-signing-certificates");
// Disposable keys remain in memory and never enter an account or signing service.
const generated = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keyPair = {
  privateKey: forge.pki.privateKeyFromPem(generated.privateKey),
  publicKey: forge.pki.publicKeyFromPem(generated.publicKey),
};
const certificate = expo.generateSelfSignedCodeSigningCertificate({
  keyPair,
  validityNotBefore: new Date(Date.now() - 60_000),
  validityNotAfter: new Date(Date.now() + 3_600_000),
  commonName: "Disposable compatibility fixture",
});

test("Expo certificate and CSR helpers preserve ordinary signing behavior", () => {
  const parsed = expo.convertCertificatePEMToCertificate(
    expo.convertCertificateToCertificatePEM(certificate),
  );
  expo.validateSelfSignedCertificate(parsed, keyPair);
  const csr = expo.generateCSR(keyPair, "Disposable compatibility fixture");
  assert.equal(expo.convertCSRPEMToCSR(expo.convertCSRToCSRPEM(csr)).verify(), true);
  const message = Buffer.from("synthetic compatibility message");
  const signature = Buffer.from(
    expo.signBufferRSASHA256AndVerify(keyPair.privateKey, parsed, message),
    "base64",
  );
  assert.equal(verify("sha256", message, generated.publicKey, signature), true);
  assert.equal(
    verify("sha256", Buffer.from("different message"), generated.publicKey, signature),
    false,
  );
});

test("EAS reads a disposable password-protected certificate and rejects a wrong password", () => {
  const eas = createRequire(require.resolve("eas-cli/package.json"));
  const reader = eas("./build/credentials/ios/utils/p12Certificate.js");
  const password = "fixture-only-password";
  const archive = forge.pkcs12.toPkcs12Asn1(keyPair.privateKey, certificate, password, {
    algorithm: "3des",
  });
  const bytes = Buffer.from(forge.asn1.toDer(archive).getBytes(), "binary");
  const certificateBytes = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    "binary",
  );
  const fingerprint = createHash("sha1").update(certificateBytes).digest("hex").toUpperCase();
  assert.equal(reader.getP12CertFingerprint(bytes, password), fingerprint);
  assert.equal(reader.getP12CertFingerprint(bytes.toString("base64"), password), fingerprint);
  assert.equal(
    reader.findP12CertSerialNumber(bytes, password),
    certificate.serialNumber.replace(/^0+/, "").toUpperCase(),
  );
  assert.throws(
    () => reader.getP12CertFingerprint(bytes, "wrong-fixture-password"),
    /password|MAC/i,
  );
});
