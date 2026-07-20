// SSH receipt signing over the unsigned receipt's sha256. Best-effort by design:
// unconfigured or failing signing yields an unsigned receipt (never an error);
// only a present-but-invalid signature is a finding. Namespace separates these
// signatures from git's own ("git" namespace) — a receipt sig can't be replayed
// as a commit sig or vice versa.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NAMESPACE = "sddx-receipt";

export interface ReceiptSignature {
  signature: string;
  signer: string;
}

// audit calls verifySignature once per receipt; per-repo config is constant for
// the process lifetime, so cache lookups instead of re-spawning git each time
const gitConfigCache = new Map<string, string | null>();

function gitConfig(cwd: string, key: string): string | null {
  const cacheKey = `${cwd}\0${key}`;
  const cached = gitConfigCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const r = spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8" });
  const v = r.status === 0 ? (r.stdout ?? "").trim() : "";
  const result = v === "" ? null : v;
  gitConfigCache.set(cacheKey, result);
  return result;
}

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function signPayload(cwd: string, payload: string): ReceiptSignature | null {
  if (gitConfig(cwd, "gpg.format") !== "ssh") return null;
  const key = gitConfig(cwd, "user.signingkey");
  // literal "ssh-ed25519 AAAA..." keys need an ssh-agent round-trip — unsupported, stay unsigned
  if (!key || key.startsWith("ssh-")) return null;
  const signer = gitConfig(cwd, "user.email");
  if (!signer) return null;
  const r = spawnSync("ssh-keygen", ["-Y", "sign", "-n", NAMESPACE, "-f", expandHome(key)], {
    cwd,
    input: payload,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const signature = (r.stdout ?? "").trim();
  return signature.startsWith("-----BEGIN SSH SIGNATURE-----") ? { signature, signer } : null;
}

export function verifySignature(
  cwd: string,
  payload: string,
  sig: ReceiptSignature,
): "valid" | "invalid" | "unverifiable" {
  const allowed = gitConfig(cwd, "gpg.ssh.allowedSignersFile");
  if (!allowed) return "unverifiable";
  const tmp = mkdtempSync(join(tmpdir(), "sddx-sig-"));
  try {
    const sigFile = join(tmp, "receipt.sig");
    writeFileSync(sigFile, `${sig.signature}\n`);
    const r = spawnSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", expandHome(allowed), "-I", sig.signer, "-n", NAMESPACE, "-s", sigFile],
      { cwd, input: payload, encoding: "utf8" },
    );
    return r.status === 0 ? "valid" : "invalid";
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
