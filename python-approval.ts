import crypto from "node:crypto";

export type PythonApprovalFile = {
  path: string;
  size: number;
  sha256: string;
};

export type PythonApprovalManifest = {
  entrypoint: string;
  files: PythonApprovalFile[];
  arguments: string[];
  timeoutSeconds: number;
};

type ApprovalPayload = {
  id: string;
  expiresAt: number;
  manifestHash: string;
};

const canonicalManifest = (manifest: PythonApprovalManifest) => JSON.stringify({
  entrypoint: manifest.entrypoint,
  files: [...manifest.files]
    .map(file => ({ path: file.path, size: file.size, sha256: file.sha256.toLowerCase() }))
    .sort((left, right) => left.path.localeCompare(right.path)),
  arguments: manifest.arguments,
  timeoutSeconds: manifest.timeoutSeconds
});

export const hashPythonApprovalManifest = (manifest: PythonApprovalManifest) => crypto
  .createHash("sha256")
  .update(canonicalManifest(manifest))
  .digest("hex");

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export class PythonApprovalAuthority {
  private readonly secret = crypto.randomBytes(32);
  private readonly consumed = new Set<string>();

  issue(manifest: PythonApprovalManifest, ttlMs = 2 * 60_000) {
    const payload: ApprovalPayload = {
      id: crypto.randomUUID(),
      expiresAt: Date.now() + Math.max(10_000, Math.min(ttlMs, 5 * 60_000)),
      manifestHash: hashPythonApprovalManifest(manifest)
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = crypto.createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return { token: `${encoded}.${signature}`, id: payload.id, expiresAt: payload.expiresAt };
  }

  consume(token: unknown, manifest: PythonApprovalManifest) {
    if (typeof token !== "string" || token.length > 4_000) throw new Error("缺少有效的 Python 操作授权。");
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw new Error("Python 操作授权格式无效。");
    const expected = crypto.createHmac("sha256", this.secret).update(encoded).digest("base64url");
    if (!safeEqual(signature, expected)) throw new Error("Python 操作授权签名无效。");

    let payload: ApprovalPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new Error("Python 操作授权内容无效。");
    }
    if (!payload?.id || !Number.isFinite(payload.expiresAt) || typeof payload.manifestHash !== "string") {
      throw new Error("Python 操作授权内容不完整。");
    }
    if (payload.expiresAt < Date.now()) throw new Error("Python 操作授权已过期，请重新确认。");
    if (this.consumed.has(payload.id)) throw new Error("Python 操作授权已经使用，不能重复执行。");
    if (!safeEqual(payload.manifestHash, hashPythonApprovalManifest(manifest))) {
      throw new Error("Python 脚本、输入文件或参数在授权后发生变化，请重新确认。");
    }
    this.consumed.add(payload.id);
    if (this.consumed.size > 10_000) this.consumed.clear();
    return payload.id;
  }
}
