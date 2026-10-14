/**
 * Runs the sandbox locally over real HTTPS on *.sandbox.lvh.me (public DNS
 * that resolves to 127.0.0.1). Generates a local CA and a certificate for every
 * sandbox hostname on first run, then starts the built server with Node
 * trusting that CA, so the origins talk to each other exactly as deployed.
 *
 *   pnpm --filter @ojcp/sandbox build && pnpm --filter @ojcp/sandbox local
 *
 * Trust .local/ca.pem in your browser to avoid the certificate warning.
 */
import "reflect-metadata";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as x509 from "@peculiar/x509";

const DOMAIN = process.env.SANDBOX_DOMAIN ?? "sandbox.lvh.me";
const PORT = Number(process.env.PORT ?? 8443);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".local");
const caPem = join(dir, "ca.pem");
const keyPem = join(dir, "key.pem");
const certPem = join(dir, "cert.pem");
const hostsFile = join(dir, "hosts.txt");
const HOSTS = [
  "",
  "issuer",
  "agent",
  "acme",
  "acme-careers",
  "ats",
  "globex.ats",
  "attest-a",
  "attest-b",
  "lists",
  "hr",
  "wallet",
].map((h) => (h ? `${h}.${DOMAIN}` : DOMAIN));

function pem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function generate(): Promise<void> {
  x509.cryptoProvider.set(crypto);
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const now = Date.now();
  const validity = {
    notBefore: new Date(now - 86_400_000),
    notAfter: new Date(now + 365 * 86_400_000),
  };
  const caKeys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=OJCP sandbox local CA (test only)",
    ...validity,
    signingAlgorithm: alg,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  const leafKeys = (await crypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: `CN=${DOMAIN}`,
    issuer: ca.subject,
    ...validity,
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.SubjectAlternativeNameExtension(
        HOSTS.map((value) => ({ type: "dns" as const, value })),
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(caPem, pem("CERTIFICATE", ca.rawData));
  writeFileSync(certPem, pem("CERTIFICATE", leaf.rawData) + pem("CERTIFICATE", ca.rawData));
  writeFileSync(
    keyPem,
    pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", leafKeys.privateKey)),
  );
  writeFileSync(hostsFile, HOSTS.join("\n"));
}

const current = existsSync(hostsFile) ? readFileSync(hostsFile, "utf8") : "";
if (current !== HOSTS.join("\n")) await generate();

const main = join(root, "dist", "main.mjs");
if (!existsSync(main)) throw new Error("build first: pnpm --filter @ojcp/sandbox build");
const child = spawn(process.execPath, [main], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_EXTRA_CA_CERTS: caPem,
    SANDBOX_DOMAIN: DOMAIN,
    PORT: String(PORT),
    SANDBOX_PUBLIC_PORT: String(PORT),
    SANDBOX_TLS_KEY: keyPem,
    SANDBOX_TLS_CERT: certPem,
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
