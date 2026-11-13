import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";

function keyOf(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new AppError("INTERNAL", "模型密钥保护尚未配置，请联系系统管理员");
  }
  return Buffer.from(encoded, "base64");
}

export function encryptModelKey(encoded: string, providerId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(encoded), iv);
  cipher.setAAD(Buffer.from(providerId, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptModelKey(encoded: string, providerId: string, value: string): string {
  const key = keyOf(encoded);
  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new AppError("INTERNAL", "模型服务密钥无法读取，请重新设置");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(providerId, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("INTERNAL", "模型服务密钥无法读取，请重新设置");
  }
}
